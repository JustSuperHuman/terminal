import type { TerminalSessionSummary } from "../types";

/** The launch directory follows committed selection, never a scrub preview. */
export class SessionLaunchDirectory {
  private selectedId?: string;
  private selectedCwd?: string;
  private fallback?: string;
  private override?: { cwd?: string };

  get cwd(): string | undefined {
    return this.override ? this.override.cwd : this.selectedCwd || this.fallback;
  }

  restore(cwd?: string): void { this.fallback = cwd; }

  select(session?: Pick<TerminalSessionSummary, "id" | "cwd">): void {
    if (!session) return; // Keep the last directory if that terminal closes.
    if (session.id !== this.selectedId) this.override = undefined;
    this.selectedId = session.id;
    this.selectedCwd = session.cwd || this.selectedCwd;
  }

  choose(cwd?: string): void { this.override = { cwd }; }
}
