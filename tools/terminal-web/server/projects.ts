import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { RecentProject, TerminalProject } from "./types.js";

const MAX_RECENT_PROJECTS = 10;

function isTerminalProject(value: unknown): value is TerminalProject {
  const candidate = value as TerminalProject | undefined;
  return Boolean(
    candidate &&
      typeof candidate.id === "string" &&
      typeof candidate.name === "string" &&
      typeof candidate.cwd === "string" &&
      typeof candidate.createdAt === "string"
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

function recentCwdKey(cwd: string) {
  return process.platform === "win32" ? cwd.toLowerCase() : cwd;
}

export class ProjectStore {
  private readonly filePath = path.resolve(process.cwd(), ".terminal-web-projects.json");
  private projects: TerminalProject[];
  private recentProjects: RecentProject[];

  constructor() {
    const { projects, recents } = this.load();
    this.projects = projects;
    this.recentProjects = recents;
  }

  list(): TerminalProject[] {
    return [...this.projects];
  }

  recents(): RecentProject[] {
    return [...this.recentProjects];
  }

  create(name: string, cwd: string): TerminalProject {
    const trimmedName = name.trim();
    const trimmedCwd = cwd.trim();
    if (!trimmedName) {
      throw new Error("Project name is required.");
    }
    if (!trimmedCwd) {
      throw new Error("Project directory is required.");
    }

    const resolvedCwd = path.resolve(trimmedCwd);
    if (!existsSync(resolvedCwd)) {
      throw new Error(`Project directory does not exist: ${resolvedCwd}`);
    }

    const project: TerminalProject = {
      id: randomUUID(),
      name: trimmedName,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString()
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  remove(id: string): TerminalProject | undefined {
    const index = this.projects.findIndex((project) => project.id === id);
    if (index < 0) {
      return undefined;
    }

    const [removed] = this.projects.splice(index, 1);
    const removedKey = recentCwdKey(removed.cwd);
    this.recentProjects = [
      { name: removed.name, cwd: removed.cwd, closedAt: new Date().toISOString() },
      ...this.recentProjects.filter((recent) => recentCwdKey(recent.cwd) !== removedKey)
    ].slice(0, MAX_RECENT_PROJECTS);
    this.save();
    return removed;
  }

  reorder(ids: string[]): TerminalProject[] {
    const byId = new Map(this.projects.map((project) => [project.id, project]));
    const ordered = ids.map((id) => byId.get(id)).filter((project): project is TerminalProject => Boolean(project));
    const orderedIds = new Set(ordered.map((project) => project.id));
    this.projects = [...ordered, ...this.projects.filter((project) => !orderedIds.has(project.id))];
    this.save();
    return this.list();
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
