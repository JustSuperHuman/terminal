import type { SessionInputSnapshot } from "./terminal-manager.js";
import { describeInputContext, type SessionInputContext } from "./session-input.js";
import type { TerminalAgentObservation } from "./terminal-agent-metadata.js";

export interface TerminalPromptAttention {
  sessionId: string;
  context: SessionInputContext;
}

export interface TerminalAgentObservationEvent extends TerminalAgentObservation {
  sessionId: string;
}

export interface TerminalPromptMonitorOptions {
  settleMs?: number;
  /**
   * Fired on every settled render, not only on new questions. This is what
   * makes a hand-launched `claude` become an agent terminal everywhere, and
   * what keeps its live thinking/awaiting state honest.
   */
  onObservation?: (event: TerminalAgentObservationEvent) => void;
}

function observe(context: SessionInputContext): TerminalAgentObservation {
  if (context.agent !== "claude" && context.agent !== "codex") {
    return {};
  }
  return {
    agent: context.agent,
    activity: context.prompt ? "awaiting" : context.busy ? "working" : "idle"
  };
}

/**
 * Watches rendered terminal state for a newly-blocking Claude/Codex question.
 *
 * Raw terminal sessions do not expose ACP requests, so their rendered dialog
 * is the compatibility boundary. The monitor is deliberately edge-triggered:
 * cursor movement, multi-select redraws, and repeated output for the same
 * prompt must not produce another phone notification.
 */
export class TerminalPromptMonitor {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activePromptIds = new Map<string, string>();
  private readonly lastInspectedAt = new Map<string, number>();

  private readonly settleMs: number;
  private readonly onObservation?: (event: TerminalAgentObservationEvent) => void;

  constructor(
    private readonly readSnapshot: (sessionId: string) => SessionInputSnapshot | undefined,
    private readonly onAttention: (event: TerminalPromptAttention) => void,
    options: TerminalPromptMonitorOptions = {}
  ) {
    this.settleMs = options.settleMs ?? 180;
    this.onObservation = options.onObservation;
  }

  schedule(sessionId: string): void {
    const current = this.timers.get(sessionId);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.inspect(sessionId);
    }, this.settleMs);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  /**
   * Catches terminals that say nothing.
   *
   * The output path covers everything that prints, but a session that was
   * already sitting at an agent prompt when this host started would otherwise
   * stay unclassified until its next byte. Only sessions nothing has looked at
   * recently are re-read, so this stays off the hot path.
   */
  sweep(sessionIds: Iterable<string>, maxAgeMs = 5_000): void {
    const now = Date.now();
    for (const sessionId of sessionIds) {
      const seen = this.lastInspectedAt.get(sessionId);
      if (seen !== undefined && now - seen < maxAgeMs) continue;
      if (this.timers.has(sessionId)) continue;
      this.inspect(sessionId);
    }
  }

  inspect(sessionId: string): void {
    this.lastInspectedAt.set(sessionId, Date.now());
    const snapshot = this.readSnapshot(sessionId);
    if (!snapshot || snapshot.session.status !== "running") {
      this.activePromptIds.delete(sessionId);
      this.onObservation?.({ sessionId });
      return;
    }

    const context = describeInputContext(snapshot.session, snapshot.text, snapshot.modes);
    this.onObservation?.({ sessionId, ...observe(context) });
    const prompt = context.agent === "claude" || context.agent === "codex" ? context.prompt : undefined;
    if (!prompt) {
      this.activePromptIds.delete(sessionId);
      return;
    }

    if (this.activePromptIds.get(sessionId) === prompt.id) return;
    this.activePromptIds.set(sessionId, prompt.id);
    this.onAttention({ sessionId, context });
  }

  dispose(sessionId?: string): void {
    if (sessionId) {
      const timer = this.timers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.timers.delete(sessionId);
      this.activePromptIds.delete(sessionId);
      this.lastInspectedAt.delete(sessionId);
      return;
    }

    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.activePromptIds.clear();
    this.lastInspectedAt.clear();
  }
}
