import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

// Backs `@file` completion for remote clients. Claude Code and Codex both take
// `@relative/path` references, but a phone has no view of the host filesystem —
// so the host indexes the session's working directory and answers fuzzy
// queries against it.

export interface FileHit {
  /** Relative to the session cwd, forward-slashed (both agents accept that). */
  path: string;
  name: string;
  dir: string;
  kind: "file" | "dir";
}

interface IndexEntry extends FileHit {
  lower: string;
  lowerName: string;
  depth: number;
}

interface CacheEntry {
  at: number;
  entries: IndexEntry[];
}

const CACHE_TTL_MS = 45_000;
const MAX_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 7;
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

// Directories a repository walk should never descend into: build output and
// dependency trees dwarf the source and are never what an `@` mention means.
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vs",
  ".vscode",
  ".next",
  ".nuxt",
  ".expo",
  ".gradle",
  ".venv",
  "__pycache__",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "packages",
  "coverage"
]);

const cache = new Map<string, CacheEntry>();

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function makeEntry(relative: string, kind: "file" | "dir"): IndexEntry {
  const normalized = toPosix(relative).replace(/^\.\//, "");
  const slash = normalized.lastIndexOf("/");
  const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  return {
    path: normalized,
    name,
    dir: slash >= 0 ? normalized.slice(0, slash) : "",
    kind,
    lower: normalized.toLowerCase(),
    lowerName: name.toLowerCase(),
    depth: normalized.split("/").length
  };
}

function gitListFiles(cwd: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard"],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        );
      }
    );
  });
}

async function walkDirectory(cwd: string): Promise<Array<{ relative: string; kind: "file" | "dir" }>> {
  const found: Array<{ relative: string; kind: "file" | "dir" }> = [];

  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_ENTRIES) {
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= MAX_ENTRIES) {
        return;
      }
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) {
          continue;
        }
        found.push({ relative: childRelative, kind: "dir" });
        await walk(path.join(directory, entry.name), childRelative, depth + 1);
      } else if (entry.isFile()) {
        found.push({ relative: childRelative, kind: "file" });
      }
    }
  };

  await walk(cwd, "", 0);
  return found;
}

async function buildIndex(cwd: string): Promise<IndexEntry[]> {
  const tracked = await gitListFiles(cwd);
  if (tracked && tracked.length > 0) {
    const entries = tracked.slice(0, MAX_ENTRIES).map((relative) => makeEntry(relative, "file"));
    // git lists files only; the directories they live in are just as
    // mentionable, so derive them.
    const directories = new Set<string>();
    for (const entry of entries) {
      const segments = entry.path.split("/");
      segments.pop();
      let prefix = "";
      for (const segment of segments) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        directories.add(prefix);
      }
    }
    for (const directory of directories) {
      entries.push(makeEntry(directory, "dir"));
    }
    return entries;
  }

  const walked = await walkDirectory(cwd);
  return walked.map((entry) => makeEntry(entry.relative, entry.kind));
}

async function getIndex(cwd: string): Promise<IndexEntry[]> {
  const cached = cache.get(cwd);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.entries;
  }

  const entries = await buildIndex(cwd);
  cache.set(cwd, { at: now, entries });
  return entries;
}

/** Ordered subsequence match, scored so tight runs beat scattered letters. */
function subsequenceScore(haystack: string, needle: string): number | undefined {
  let cursor = 0;
  let gaps = 0;
  let previous = -1;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found < 0) {
      return undefined;
    }
    if (previous >= 0) {
      gaps += found - previous - 1;
    }
    previous = found;
    cursor = found + 1;
  }
  return 300 - Math.min(200, gaps);
}

function scoreEntry(entry: IndexEntry, query: string): number | undefined {
  if (!query) {
    return 100 - entry.depth;
  }

  if (entry.lowerName.startsWith(query)) {
    return 1000 - entry.lowerName.length - entry.depth * 2;
  }
  if (entry.lower.startsWith(query)) {
    return 900 - entry.lower.length - entry.depth;
  }

  const nameIndex = entry.lowerName.indexOf(query);
  if (nameIndex >= 0) {
    return 800 - nameIndex * 3 - entry.lowerName.length - entry.depth * 2;
  }

  const pathIndex = entry.lower.indexOf(query);
  if (pathIndex >= 0) {
    return 650 - pathIndex - entry.depth * 2;
  }

  const fuzzy = subsequenceScore(entry.lower, query);
  return fuzzy === undefined ? undefined : fuzzy - entry.depth * 2;
}

export async function searchFiles(cwd: string, rawQuery: string, limit: number): Promise<FileHit[]> {
  const entries = await getIndex(cwd);
  const query = rawQuery.trim().replace(/^@/, "").replace(/\\/g, "/").toLowerCase();

  const ranked: Array<{ entry: IndexEntry; score: number }> = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, query);
    if (score !== undefined) {
      ranked.push({ entry, score });
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path));

  return ranked.slice(0, limit).map(({ entry }) => ({
    path: entry.path,
    name: entry.name,
    dir: entry.dir,
    kind: entry.kind
  }));
}

/** Drops the cached listing for a directory (used when a session's cwd moves). */
export function forgetFileIndex(cwd: string): void {
  cache.delete(cwd);
}
