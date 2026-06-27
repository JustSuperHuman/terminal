import { EventEmitter } from "node:events";
import path from "node:path";
import * as Headless from "@xterm/headless";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import * as pty from "node-pty";
import { getDefaultProfile, getShellProfiles } from "./shell-profiles.js";
import type { TerminalProfile, TerminalSessionExport, TerminalSessionSummary, TranscriptChunk } from "./types.js";

const HeadlessTerminal = ((Headless as any).Terminal ?? (Headless as any).default?.Terminal) as {
  new (options: ConstructorParameters<typeof Headless.Terminal>[0]): HeadlessTerminalType;
};

interface CreateSessionOptions {
  title?: string;
  profileId?: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

interface ManagedTerminalSession {
  id: string;
  title: string;
  shell: string;
  args: string[];
  cwd: string;
  pty: pty.IPty;
  headless: HeadlessTerminalType;
  serializer: SerializeAddon;
  status: "running" | "exited";
  createdAt: Date;
  updatedAt: Date;
  cols: number;
  rows: number;
  seq: number;
  transcript: TranscriptChunk[];
  bufferedBytes: number;
  exitCode?: number;
  signal?: number;
}

const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

function makeId(): string {
  return `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function profileToTitle(profile: TerminalProfile): string {
  return profile.label;
}

function cleanTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

export class TerminalManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedTerminalSession>();
  readonly profiles = getShellProfiles();

  createSession(options: CreateSessionOptions = {}): TerminalSessionSummary {
    const profile = options.profileId
      ? this.profiles.find((candidate) => candidate.id === options.profileId) ?? getDefaultProfile()
      : getDefaultProfile();

    const shell = options.shell ?? profile.shell;
    const args = options.args ?? profile.args;
    const cwd = options.cwd ?? process.cwd();
    const cols = Math.max(20, Math.min(options.cols ?? 120, 400));
    const rows = Math.max(8, Math.min(options.rows ?? 32, 200));
    const id = makeId();
    const title = options.title?.trim() || profileToTitle(profile);

    const headless = new HeadlessTerminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 5000
    });
    const serializer = new SerializeAddon();
    headless.loadAddon(serializer);

    const term = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1"
      }
    });

    const session: ManagedTerminalSession = {
      id,
      title,
      shell,
      args,
      cwd,
      pty: term,
      headless,
      serializer,
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
      cols,
      rows,
      seq: 0,
      transcript: [],
      bufferedBytes: 0
    };

    term.onData((data) => {
      this.appendOutput(session, data);
    });

    term.onExit(({ exitCode, signal }) => {
      session.status = "exited";
      session.exitCode = exitCode;
      session.signal = signal;
      session.updatedAt = new Date();
      this.emit("exit", {
        sessionId: session.id,
        exitCode,
        signal,
        session: this.toSummary(session)
      });
      this.emit("sessions", this.listSessions());
    });

    this.sessions.set(id, session);
    this.emit("session", this.toSummary(session));
    this.emit("sessions", this.listSessions());
    return this.toSummary(session);
  }

  ensureDefaultSession(): TerminalSessionSummary {
    const running = [...this.sessions.values()].find((session) => session.status === "running");
    if (running) {
      return this.toSummary(running);
    }
    return this.createSession();
  }

  listSessions(): TerminalSessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((session) => this.toSummary(session));
  }

  getSession(id: string): TerminalSessionSummary | undefined {
    const session = this.sessions.get(id);
    return session ? this.toSummary(session) : undefined;
  }

  getExport(id: string): TerminalSessionExport {
    const session = this.requireSession(id);
    const chunks = [...session.transcript];
    let screen: string | undefined;

    try {
      screen = session.serializer.serialize({ scrollback: 5000 });
    } catch {
      screen = undefined;
    }

    return {
      session: this.toSummary(session),
      screen,
      transcript: chunks.map((chunk) => chunk.data).join(""),
      chunks
    };
  }

  getSnapshot(id: string): { screen?: string; chunks: TranscriptChunk[]; session: TerminalSessionSummary } {
    const session = this.requireSession(id);
    let screen: string | undefined;

    try {
      screen = session.serializer.serialize({ scrollback: 5000 });
    } catch {
      screen = undefined;
    }

    return {
      screen,
      chunks: screen ? [] : [...session.transcript],
      session: this.toSummary(session)
    };
  }

  write(id: string, data: string): void {
    const session = this.requireSession(id);
    if (session.status !== "running") {
      return;
    }
    session.pty.write(data);
    session.updatedAt = new Date();
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.requireSession(id);
    const nextCols = Math.max(20, Math.min(Math.floor(cols), 400));
    const nextRows = Math.max(8, Math.min(Math.floor(rows), 200));
    if (session.cols === nextCols && session.rows === nextRows) {
      return;
    }
    session.cols = nextCols;
    session.rows = nextRows;
    session.updatedAt = new Date();
    session.headless.resize(nextCols, nextRows);
    if (session.status === "running") {
      session.pty.resize(nextCols, nextRows);
    }
    this.emit("session", this.toSummary(session));
  }

  kill(id: string): void {
    const session = this.requireSession(id);
    if (session.status === "running") {
      session.pty.kill();
    }
  }

  rename(id: string, title: string): TerminalSessionSummary {
    const session = this.requireSession(id);
    const nextTitle = cleanTitle(title);
    if (nextTitle) {
      session.title = nextTitle;
      session.updatedAt = new Date();
      const summary = this.toSummary(session);
      this.emit("session", summary);
      this.emit("sessions", this.listSessions());
      return summary;
    }
    return this.toSummary(session);
  }

  private appendOutput(session: ManagedTerminalSession, data: string): void {
    session.seq += 1;
    session.updatedAt = new Date();
    session.headless.write(data);

    const chunk: TranscriptChunk = {
      seq: session.seq,
      data,
      at: session.updatedAt.toISOString()
    };

    session.transcript.push(chunk);
    session.bufferedBytes += byteLength(data);

    while (session.bufferedBytes > MAX_TRANSCRIPT_BYTES && session.transcript.length > 1) {
      const removed = session.transcript.shift();
      if (removed) {
        session.bufferedBytes -= byteLength(removed.data);
      }
    }

    this.emit("output", {
      sessionId: session.id,
      seq: session.seq,
      data
    });
  }

  private toSummary(session: ManagedTerminalSession): TerminalSessionSummary {
    return {
      id: session.id,
      title: session.title,
      shell: session.shell,
      args: session.args,
      cwd: path.resolve(session.cwd),
      source: "managed",
      pid: session.pty.pid,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      cols: session.cols,
      rows: session.rows,
      exitCode: session.exitCode,
      signal: session.signal,
      bufferedBytes: session.bufferedBytes
    };
  }

  private requireSession(id: string): ManagedTerminalSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown terminal session: ${id}`);
    }
    return session;
  }
}
