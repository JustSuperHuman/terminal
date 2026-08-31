import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { RecentProject, TerminalProject } from "./types.js";

const MAX_RECENT_PROJECTS = 10;
const MAX_PROJECT_NAME_LENGTH = 80;

function isTerminalProject(value: unknown): value is TerminalProject {
  const candidate = value as TerminalProject | undefined;
  return Boolean(
    candidate &&
      typeof candidate.id === "string" &&
      typeof candidate.name === "string" &&
      typeof candidate.cwd === "string" &&
      typeof candidate.createdAt === "string" &&
      (candidate.automatic === undefined || typeof candidate.automatic === "boolean")
  );
}

function isRecentProject(value: unknown): value is RecentProject {
  const candidate = value as RecentProject | undefined;
  return Boolean(
    candidate &&
      typeof candidate.name === "string" &&
      typeof candidate.cwd === "string" &&
      typeof candidate.closedAt === "string"
  );
}

function normalizedCwd(cwd: string): string | undefined {
  const trimmed = cwd.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

function cwdKey(cwd: string): string {
  const normalized = normalizedCwd(cwd) ?? cwd;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function cleanProjectName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const name = value.trim().replace(/\s+/g, " ").slice(0, MAX_PROJECT_NAME_LENGTH);
  return name || undefined;
}

function projectJsonName(cwd: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(cwd, "project.json"), "utf8")) as Record<string, unknown>;
    const nestedProject = parsed.project as Record<string, unknown> | undefined;
    return (
      cleanProjectName(parsed.name) ??
      cleanProjectName(parsed.displayName) ??
      cleanProjectName(parsed.projectName) ??
      cleanProjectName(parsed.title) ??
      cleanProjectName(nestedProject?.name)
    );
  } catch {
    return undefined;
  }
}

function gitConfigPath(cwd: string): string | undefined {
  const dotGit = path.join(cwd, ".git");
  try {
    if (existsSync(path.join(dotGit, "config"))) {
      return path.join(dotGit, "config");
    }

    const pointer = readFileSync(dotGit, "utf8").trim();
    if (pointer.toLowerCase().startsWith("gitdir:")) {
      const gitDir = pointer.slice("gitdir:".length).trim();
      return path.join(path.resolve(cwd, gitDir), "config");
    }
  } catch {
    // Not a repository root, or its metadata is inaccessible.
  }
  return undefined;
}

function gitMetadataName(cwd: string): string | undefined {
  const configPath = gitConfigPath(cwd);
  if (!configPath) {
    return undefined;
  }

  let config: string;
  try {
    config = readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }

  let inOrigin = false;
  let remoteUrl: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      inOrigin = section[1]?.trim().toLowerCase() === 'remote "origin"';
      continue;
    }
    if (inOrigin) {
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (url?.[1]) {
        remoteUrl = url[1];
        break;
      }
    }
  }
  if (!remoteUrl) {
    return undefined;
  }

  const segments = remoteUrl
    .replace(/\\/g, "/")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^.*?:/, "")
    .split("/")
    .filter(Boolean);
  const repository = segments.at(-1)?.replace(/\.git$/i, "");
  const owner = segments.at(-2);
  const directory = path.basename(cwd);
  const directoryKey = directory.replace(/[^a-z0-9]/gi, "").toLowerCase();

  for (const candidate of [owner, repository]) {
    if (candidate && candidate.replace(/[^a-z0-9]/gi, "").toLowerCase() === directoryKey) {
      return cleanProjectName(candidate);
    }
  }

  // Preserve remote casing when a repository adds a descriptive suffix,
  // e.g. directory `justgains` + repo `JustGains-Monorepo` => `JustGains`.
  if (
    repository &&
    repository.slice(0, directory.length).toLowerCase() === directory.toLowerCase() &&
    /^[-_. ]/.test(repository.slice(directory.length, directory.length + 1))
  ) {
    return cleanProjectName(repository.slice(0, directory.length));
  }

  return undefined;
}

function directoryDisplayName(cwd: string): string {
  const parsed = path.parse(cwd);
  const directory = path.basename(cwd) || parsed.name || parsed.root.replace(/[\\/:]+/g, "") || cwd;
  return directory
    .split(/([\s_-]+)/)
    .map((part) => (/^[\s_-]+$/.test(part) || /[A-Z]/.test(part) ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join("")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

function automaticProjectId(cwd: string): string {
  return `directory-${createHash("sha256").update(cwdKey(cwd)).digest("hex").slice(0, 24)}`;
}

function sameProjects(left: TerminalProject[], right: TerminalProject[]): boolean {
  return (
    left.length === right.length &&
    left.every((project, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        project.id === other.id &&
        project.name === other.name &&
        project.cwd === other.cwd &&
        project.createdAt === other.createdAt &&
        project.automatic === other.automatic
      );
    })
  );
}

export class ProjectStore {
  private readonly filePath = path.resolve(process.cwd(), ".terminal-web-projects.json");
  private projects: TerminalProject[];
  private automaticProjects: TerminalProject[] = [];
  private recentProjects: RecentProject[];
  private projectOrder: string[];
  private activeCwdKeys = new Set<string>();

  constructor() {
    const { projects, recents } = this.load();
    // Automatic entries are deliberately ephemeral. Filtering them here also
    // cleans up files written by experimental/older builds.
    this.projects = projects.filter((project) => !project.automatic);
    this.recentProjects = recents;
    this.projectOrder = this.projects.map((project) => project.id);
  }

  list(): TerminalProject[] {
    return this.orderProjects(this.allProjects().filter((project) => this.activeCwdKeys.has(cwdKey(project.cwd))));
  }

  get(id: string): TerminalProject | undefined {
    return this.allProjects().find((project) => project.id === id);
  }

  private allProjects(): TerminalProject[] {
    return [...this.projects, ...this.automaticProjects];
  }

  private orderProjects(projects: TerminalProject[]): TerminalProject[] {
    const byId = new Map(projects.map((project) => [project.id, project]));
    const ordered = this.projectOrder.map((id) => byId.get(id)).filter((project): project is TerminalProject => Boolean(project));
    const orderedIds = new Set(ordered.map((project) => project.id));
    return [...ordered, ...projects.filter((project) => !orderedIds.has(project.id))];
  }

  recents(): RecentProject[] {
    const byCwd = new Map(this.recentProjects.map((recent) => [cwdKey(recent.cwd), recent]));

    // Saved projects double as reopenable launch shortcuts even though they
    // disappear from the project strip while no terminal is using them.
    for (const project of this.projects) {
      if (this.activeCwdKeys.has(cwdKey(project.cwd))) {
        continue;
      }
      const previous = byCwd.get(cwdKey(project.cwd));
      byCwd.set(cwdKey(project.cwd), {
        name: project.name,
        cwd: project.cwd,
        closedAt: previous?.closedAt ?? project.createdAt
      });
    }

    return [...byCwd.values()]
      .sort((left, right) => Date.parse(right.closedAt) - Date.parse(left.closedAt))
      .slice(0, MAX_RECENT_PROJECTS);
  }

  create(name: string, cwd: string): TerminalProject {
    const trimmedName = name.trim();
    const resolvedCwd = normalizedCwd(cwd);
    if (!trimmedName) {
      throw new Error("Project name is required.");
    }
    if (!resolvedCwd) {
      throw new Error("Project directory is required.");
    }
    if (!existsSync(resolvedCwd)) {
      throw new Error(`Project directory does not exist: ${resolvedCwd}`);
    }
    const existingProject = this.projects.find((project) => cwdKey(project.cwd) === cwdKey(resolvedCwd));
    if (existingProject) {
      existingProject.name = trimmedName.slice(0, MAX_PROJECT_NAME_LENGTH);
      existingProject.cwd = resolvedCwd;
      if (!this.projectOrder.includes(existingProject.id)) {
        this.projectOrder.push(existingProject.id);
      }
      this.save();
      return existingProject;
    }

    // Creating a project for an automatically discovered directory promotes
    // it to a saved project with the user's chosen name.
    const automatic = this.automaticProjects.find((project) => cwdKey(project.cwd) === cwdKey(resolvedCwd));
    if (automatic) {
      this.automaticProjects = this.automaticProjects.filter((project) => project.id !== automatic.id);
      this.projectOrder = this.projectOrder.filter((id) => id !== automatic.id);
    }

    const project: TerminalProject = {
      id: randomUUID(),
      name: trimmedName.slice(0, MAX_PROJECT_NAME_LENGTH),
      cwd: resolvedCwd,
      createdAt: new Date().toISOString()
    };
    this.projects.push(project);
    this.projectOrder.push(project.id);
    this.save();
    return project;
  }

  remove(id: string): TerminalProject | undefined {
    const project = this.get(id);
    if (!project) {
      return undefined;
    }

    this.projects = this.projects.filter((candidate) => candidate.id !== id);
    this.automaticProjects = this.automaticProjects.filter((candidate) => candidate.id !== id);
    this.projectOrder = this.projectOrder.filter((candidate) => candidate !== id);

    const removedKey = cwdKey(project.cwd);
    this.recentProjects = [
      { name: project.name, cwd: project.cwd, closedAt: new Date().toISOString() },
      ...this.recentProjects.filter((recent) => cwdKey(recent.cwd) !== removedKey)
    ].slice(0, MAX_RECENT_PROJECTS);
    this.save();
    return project;
  }

  reorder(ids: string[]): TerminalProject[] {
    const visibleIds = this.list().map((project) => project.id);
    const knownIds = new Set(visibleIds);
    const requested = ids.filter((id, index) => knownIds.has(id) && ids.indexOf(id) === index);
    const requestedIds = new Set(requested);
    const reorderedVisibleIds = [...requested, ...visibleIds.filter((id) => !requestedIds.has(id))];
    const visibleIdSet = new Set(visibleIds);
    let visibleIndex = 0;
    this.projectOrder = this.orderProjects(this.allProjects()).map((project) =>
      visibleIdSet.has(project.id) ? reorderedVisibleIds[visibleIndex++]! : project.id
    );

    const ordered = this.orderProjects(this.allProjects());
    this.projects = ordered.filter((project) => !project.automatic);
    this.automaticProjects = ordered.filter((project) => project.automatic);
    this.save();
    return this.list();
  }

  syncActiveDirectories(cwds: string[]): boolean {
    const before = this.list();
    const activeDirectories = new Map<string, string>();
    for (const cwd of cwds) {
      const resolvedCwd = normalizedCwd(cwd);
      if (resolvedCwd) {
        activeDirectories.set(cwdKey(resolvedCwd), resolvedCwd);
      }
    }
    this.activeCwdKeys = new Set(activeDirectories.keys());

    const manualKeys = new Set(this.projects.map((project) => cwdKey(project.cwd)));
    const existing = new Map(this.automaticProjects.map((project) => [cwdKey(project.cwd), project]));
    const nextAutomatic: TerminalProject[] = [];

    for (const [key, resolvedCwd] of activeDirectories) {
      if (manualKeys.has(key)) {
        continue;
      }

      const previous = existing.get(key);
      nextAutomatic.push({
        id: previous?.id ?? automaticProjectId(resolvedCwd),
        name: this.resolveAutomaticName(resolvedCwd),
        cwd: resolvedCwd,
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        automatic: true
      });
    }

    this.automaticProjects = nextAutomatic;
    const liveIds = new Set([...this.projects, ...nextAutomatic].map((project) => project.id));
    this.projectOrder = this.projectOrder.filter((id) => liveIds.has(id));
    for (const project of nextAutomatic) {
      if (!this.projectOrder.includes(project.id)) {
        this.projectOrder.push(project.id);
      }
    }

    return !sameProjects(before, this.list());
  }

  projectIdForCwd(cwd: string): string | undefined {
    const key = cwdKey(cwd);
    return this.allProjects().find((project) => cwdKey(project.cwd) === key)?.id;
  }

  private resolveAutomaticName(cwd: string): string {
    const remembered = this.recentProjects.find((recent) => cwdKey(recent.cwd) === cwdKey(cwd))?.name;
    return (projectJsonName(cwd) ?? cleanProjectName(remembered) ?? gitMetadataName(cwd) ?? directoryDisplayName(cwd)) || "Project";
  }

  private load(): { projects: TerminalProject[]; recents: RecentProject[] } {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(parsed)) {
        return { projects: parsed.filter(isTerminalProject), recents: [] };
      }
      if (parsed && typeof parsed === "object") {
        const candidate = parsed as { projects?: unknown; recents?: unknown };
        return {
          projects: Array.isArray(candidate.projects) ? candidate.projects.filter(isTerminalProject) : [],
          recents: Array.isArray(candidate.recents) ? candidate.recents.filter(isRecentProject) : []
        };
      }
    } catch {
      // Missing or corrupt project files fall back to an empty project list.
    }
    return { projects: [], recents: [] };
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, `${JSON.stringify({ projects: this.projects, recents: this.recentProjects }, null, 2)}\n`);
    } catch (error) {
      console.warn("Could not persist terminal web projects:", error instanceof Error ? error.message : String(error));
    }
  }
}
