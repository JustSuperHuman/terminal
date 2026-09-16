import type { TerminalProject, TerminalSessionSummary } from "../types";

export function directoryKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

export function groupSessions(sessions: TerminalSessionSummary[], projects: TerminalProject[]) {
  const groups = new Map<string, { key: string; label: string; sublabel?: string; sessions: TerminalSessionSummary[]; rank: number }>();
  for (const session of sessions) {
    const project = projects.find((p) => p.id === session.projectId)
      ?? projects.find((p) => directoryKey(p.cwd) === directoryKey(session.cwd));
    const cwd = project?.cwd || session.cwd;
    const key = project?.id ?? directoryKey(cwd);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: project?.name || cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "No directory",
        sublabel: cwd || undefined, sessions: [], rank: project ? projects.indexOf(project) : projects.length };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)).map((group) => ({
    ...group,
    // Output, title, and activity changes never move a row under the user's finger.
    sessions: group.sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
  }));
}
