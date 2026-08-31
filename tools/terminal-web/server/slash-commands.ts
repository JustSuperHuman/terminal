import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentKind } from "./session-input.js";

// The slash commands a session will actually accept: each agent's built-ins
// plus the custom commands defined in the project and in the user's home. A
// remote client (the mobile composer) cannot see the agent's own popup, so the
// catalog is assembled here and served as data.

export type SlashCommandSource = "builtin" | "project" | "user";

export interface SlashCommand {
  /** Without the leading slash, e.g. "compact" or "review:security". */
  name: string;
  description?: string;
  /** Hint for what follows the command, e.g. "[pr-number]". */
  argumentHint?: string;
  source: SlashCommandSource;
}

const CACHE_TTL_MS = 10_000;
const MAX_CUSTOM_COMMANDS = 300;
const MAX_DEPTH = 3;

const CLAUDE_BUILTINS: SlashCommand[] = [
  { name: "add-dir", description: "Add another working directory", argumentHint: "<path>", source: "builtin" },
  { name: "agents", description: "Manage subagents", source: "builtin" },
  { name: "bug", description: "Report a bug to Anthropic", source: "builtin" },
  { name: "clear", description: "Clear the conversation history", source: "builtin" },
  { name: "compact", description: "Summarise the conversation to free context", argumentHint: "[focus]", source: "builtin" },
  { name: "config", description: "Open the config panel", source: "builtin" },
  { name: "context", description: "Show what is using the context window", source: "builtin" },
  { name: "cost", description: "Show token usage and cost", source: "builtin" },
  { name: "doctor", description: "Check the health of this installation", source: "builtin" },
  { name: "export", description: "Export the conversation", source: "builtin" },
  { name: "help", description: "List commands and shortcuts", source: "builtin" },
  { name: "hooks", description: "Manage hook configuration", source: "builtin" },
  { name: "ide", description: "Connect to an IDE", source: "builtin" },
  { name: "init", description: "Create or refresh CLAUDE.md", source: "builtin" },
  { name: "mcp", description: "Manage MCP servers", source: "builtin" },
  { name: "memory", description: "Edit the memory files", source: "builtin" },
  { name: "model", description: "Change the model", argumentHint: "[model]", source: "builtin" },
  { name: "output-style", description: "Change the output style", source: "builtin" },
  { name: "permissions", description: "Manage tool permissions", source: "builtin" },
  { name: "pr-comments", description: "Fetch comments from a pull request", source: "builtin" },
  { name: "release-notes", description: "Show what changed in Claude Code", source: "builtin" },
  { name: "resume", description: "Resume an earlier conversation", source: "builtin" },
  { name: "review", description: "Review a pull request", argumentHint: "[pr]", source: "builtin" },
  { name: "rewind", description: "Rewind the conversation or the code", source: "builtin" },
  { name: "security-review", description: "Review the changes for vulnerabilities", source: "builtin" },
  { name: "status", description: "Show version, account and connectivity", source: "builtin" },
  { name: "statusline", description: "Configure the status line", source: "builtin" },
  { name: "todos", description: "Show the current todo list", source: "builtin" },
  { name: "usage", description: "Show plan usage limits", source: "builtin" },
  { name: "vim", description: "Toggle vim editing mode", source: "builtin" }
];

const CODEX_BUILTINS: SlashCommand[] = [
  { name: "new", description: "Start a new chat", source: "builtin" },
  { name: "init", description: "Create an AGENTS.md for this repo", source: "builtin" },
  { name: "compact", description: "Summarise the conversation to free context", source: "builtin" },
  { name: "diff", description: "Show the git diff, including untracked files", source: "builtin" },
  { name: "mention", description: "Mention a file", argumentHint: "<file>", source: "builtin" },
  { name: "status", description: "Show session configuration and token usage", source: "builtin" },
  { name: "model", description: "Choose the model and reasoning effort", source: "builtin" },
  { name: "approvals", description: "Choose what Codex can do without asking", source: "builtin" },
  { name: "review", description: "Review the current changes", source: "builtin" },
  { name: "undo", description: "Undo the last Codex edit", source: "builtin" },
  { name: "mcp", description: "List the configured MCP tools", source: "builtin" },
  { name: "logout", description: "Log out of Codex", source: "builtin" },
  { name: "quit", description: "Exit Codex", source: "builtin" }
];

interface CacheEntry {
  at: number;
  commands: SlashCommand[];
}

const cache = new Map<string, CacheEntry>();

function builtinsFor(agent: AgentKind): SlashCommand[] {
  if (agent === "claude") return CLAUDE_BUILTINS;
  if (agent === "codex") return CODEX_BUILTINS;
  return [];
}

// Claude's command files carry an optional YAML header. Only two keys matter
// for a picker, so this reads them directly instead of pulling in a parser.
function parseFrontMatter(body: string): { description?: string; argumentHint?: string; rest: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(body);
  if (!match) {
    return { rest: body };
  }

  let description: string | undefined;
  let argumentHint: string | undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!pair) {
      continue;
    }
    const value = pair[2]!.trim().replace(/^["']|["']$/g, "");
    if (pair[1]!.toLowerCase() === "description") {
      description = value;
    } else if (pair[1]!.toLowerCase() === "argument-hint") {
      argumentHint = value;
    }
  }

  return { description, argumentHint, rest: match[2] ?? "" };
}

/** First readable prose line, used when a command file has no description. */
function summarise(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text && !text.startsWith("---")) {
      return text.slice(0, 120);
    }
  }
  return undefined;
}

async function readCommandDirectory(root: string, source: SlashCommandSource): Promise<SlashCommand[]> {
  const found: SlashCommand[] = [];

  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_CUSTOM_COMMANDS) {
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= MAX_CUSTOM_COMMANDS) {
        return;
      }
      if (entry.isDirectory()) {
        // Nested folders namespace their commands, matching how the agents
        // themselves address them: commands/review/api.md -> /review:api.
        await walk(path.join(directory, entry.name), `${prefix}${entry.name}:`, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }

      const file = path.join(directory, entry.name);
      let body = "";
      try {
        body = await readFile(file, "utf8");
      } catch {
        continue;
      }

      const header = parseFrontMatter(body);
      found.push({
        name: `${prefix}${entry.name.replace(/\.md$/i, "")}`,
        description: header.description ?? summarise(header.rest),
        argumentHint: header.argumentHint,
        source
      });
    }
  };

  await walk(root, "", 0);
  return found;
}

async function collect(agent: AgentKind, cwd: string): Promise<SlashCommand[]> {
  const builtins = builtinsFor(agent);
  if (agent !== "claude" && agent !== "codex") {
    return builtins;
  }

  const home = os.homedir();
  const roots: Array<{ root: string; source: SlashCommandSource }> =
    agent === "claude"
      ? [
          { root: path.join(cwd, ".claude", "commands"), source: "project" },
          { root: path.join(home, ".claude", "commands"), source: "user" }
        ]
      : [
          { root: path.join(cwd, ".codex", "prompts"), source: "project" },
          { root: path.join(home, ".codex", "prompts"), source: "user" }
        ];

  const discovered = (await Promise.all(roots.map(({ root, source }) => readCommandDirectory(root, source)))).flat();

  // Project definitions shadow user ones, and both shadow a same-named
  // built-in — the same precedence the agents apply.
  const byName = new Map<string, SlashCommand>();
  for (const command of [...builtins, ...discovered.filter((item) => item.source === "user"), ...discovered.filter((item) => item.source === "project")]) {
    byName.set(command.name, command);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSlashCommands(agent: AgentKind, cwd: string): Promise<SlashCommand[]> {
  const key = `${agent} ${cwd}`;
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.commands;
  }

  const commands = await collect(agent, cwd);
  cache.set(key, { at: now, commands });
  return commands;
}
