import path from "node:path";
import type { AcpAgentId, AcpAgentStatusView, AcpRemoteSessionView } from "./acp-types.js";
import type { TerminalSessionSummary } from "./types.js";

/**
 * One Claude/Codex conversation that a terminal could be showing.
 *
 * ACP cannot attach to the TUI process that owns a live conversation, so this
 * is a ranked guess built from the adapter's own session list: same agent,
 * same working directory, most recently touched first. The user picks; nothing
 * here attaches on its own.
 */
export interface AgentLinkCandidate extends AcpRemoteSessionView {
  /** True when the candidate's cwd is exactly the terminal's cwd. */
  exact: boolean;
}

const MAX_CANDIDATES = 8;

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Ranks an agent's known conversations against a terminal's cwd. Directory
 * containment (either direction) is accepted because a harness launched from a
 * repo root and a terminal that has since `cd`-ed into a package are still the
 * same piece of work — but exact matches always sort first.
 */
export function agentLinkCandidates(
  status: AcpAgentStatusView | undefined,
  cwd: string
): AgentLinkCandidate[] {
  if (!status?.availableSessions.length) {
    return [];
  }

  const target = normalize(cwd);
  const matches: AgentLinkCandidate[] = [];

  for (const remote of status.availableSessions) {
    if (!remote.cwd) continue;
    const candidate = normalize(remote.cwd);
    const exact = candidate === target;
    if (!exact && !isWithin(candidate, target) && !isWithin(target, candidate)) continue;
    matches.push({ ...remote, exact });
  }

  return matches
    .sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    })
    .slice(0, MAX_CANDIDATES);
}

export function terminalAcpAgent(session: TerminalSessionSummary): AcpAgentId | undefined {
  return session.agent === "claude" || session.agent === "codex" ? session.agent : undefined;
}

/**
 * Remembers which terminal a user opened an ACP conversation from.
 *
 * The link is a UI convenience, not a protocol relationship: it is what lets
 * the phone reopen the same agent view from the same terminal row instead of
 * asking again. Links are dropped when either side goes away.
 */
export class AgentLinkRegistry {
  private readonly byTerminal = new Map<string, string>();
  private readonly byAcp = new Map<string, string>();

  link(terminalSessionId: string, acpSessionId: string): void {
    this.unlinkTerminal(terminalSessionId);
    this.unlinkAcp(acpSessionId);
    this.byTerminal.set(terminalSessionId, acpSessionId);
    this.byAcp.set(acpSessionId, terminalSessionId);
  }

  acpFor(terminalSessionId: string): string | undefined {
    return this.byTerminal.get(terminalSessionId);
  }

  terminalFor(acpSessionId: string): string | undefined {
    return this.byAcp.get(acpSessionId);
  }

  unlinkTerminal(terminalSessionId: string): string | undefined {
    const acpSessionId = this.byTerminal.get(terminalSessionId);
    if (acpSessionId) {
      this.byTerminal.delete(terminalSessionId);
      this.byAcp.delete(acpSessionId);
    }
    return acpSessionId;
  }

  unlinkAcp(acpSessionId: string): string | undefined {
    const terminalSessionId = this.byAcp.get(acpSessionId);
    if (terminalSessionId) {
      this.byAcp.delete(acpSessionId);
      this.byTerminal.delete(terminalSessionId);
    }
    return terminalSessionId;
  }

  decorate(sessions: TerminalSessionSummary[]): TerminalSessionSummary[] {
    if (!this.byTerminal.size) return sessions;
    return sessions.map((session) => {
      const acpSessionId = this.byTerminal.get(session.id);
      return acpSessionId ? { ...session, acpSessionId } : session;
    });
  }
}
