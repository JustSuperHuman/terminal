import { EventEmitter } from "node:events";
import path from "node:path";
import * as Headless from "@xterm/headless";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebSocket } from "ws";
import {
  inferTerminalAgent,
  isTerminalAgentId,
  terminalAgentSummaryMetadata,
  updateTerminalAgentObservation,
  updateTerminalAgentPresence,
  type MutableTerminalAgentMetadata,
  type TerminalAgentObservation,
  type TerminalAgentPresenceEvent,
  type TerminalAssistAgent
} from "./terminal-agent-metadata.js";
import { extractPlainText, readTerminalModes } from "./terminal-text.js";
import type { SessionInputSnapshot } from "./terminal-manager.js";
import type {
  BridgeClientMessage,
  BridgeServerMessage,
  TerminalAgentActivity,
  TerminalAgentId,
  TerminalAgentSource,
  TerminalSessionExport,
  TerminalSessionSummary,
  TranscriptChunk
} from "./types.js";

const HeadlessTerminal = ((Headless as any).Terminal ?? (Headless as any).default?.Terminal) as {
  new (options: ConstructorParameters<typeof Headless.Terminal>[0]): HeadlessTerminalType;
};

const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

interface BridgedSession {
  summary: TerminalSessionSummary;
  socket: WebSocket;
  headless: HeadlessTerminalType;
  serializer: SerializeAddon;
  seq: number;
  transcript: TranscriptChunk[];
  bufferedBytes: number;
  baseAgent?: TerminalAgentId;
  baseAgentSource?: Exclude<TerminalAgentSource, "osc" | "screen">;
  runtimeAgent?: TerminalAssistAgent;
  screenAgent?: TerminalAssistAgent;
  agentActivity?: TerminalAgentActivity;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function clampCols(value: number): number {
  return Math.max(20, Math.min(Math.floor(value), 400));
}

function clampRows(value: number): number {
  return Math.max(8, Math.min(Math.floor(value), 200));
}

function cleanTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

function classifyLaunch(summary: TerminalSessionSummary): {
  agent?: TerminalAgentId;
  source?: Exclude<TerminalAgentSource, "osc" | "screen">;
} {
  const explicit = isTerminalAgentId(summary.agent) ? summary.agent : undefined;
  const args = Array.isArray(summary.args) ? summary.args : [];
  const agent = explicit ?? inferTerminalAgent(summary.title, [summary.shell, ...args].join(" "));
  const source = agent
    ? explicit && summary.agentSource === "profile"
      ? "profile"
      : "command"
    : undefined;
  return { agent, source };
}

function withAgentMetadata(
  summary: TerminalSessionSummary,
  metadata: MutableTerminalAgentMetadata
): TerminalSessionSummary {
  return {
    ...summary,
    ...terminalAgentSummaryMetadata(metadata)
  };
}

function send(socket: WebSocket, message: BridgeServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function parseMessage(raw: WebSocket.RawData): BridgeClientMessage | undefined {
  try {
    const value = JSON.parse(raw.toString());
    if (typeof value?.type === "string") {
      return value as BridgeClientMessage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export class BridgeRegistry extends EventEmitter {
  private readonly sessions = new Map<string, BridgedSession>();
  private readonly socketSessions = new WeakMap<WebSocket, Set<string>>();

  attach(socket: WebSocket): void {
    socket.on("message", (raw) => {
      const message = parseMessage(raw);
      if (!message) {
        send(socket, { type: "error", message: "Ignoring malformed bridge message." });
        return;
      }

      try {
        this.handleMessage(socket, message);
      } catch (error) {
        send(socket, {
          type: "error",
          message: "Bridge message failed.",
          detail: error instanceof Error ? error.message : String(error)
        });
      }
    });

    socket.on("close", () => {
      this.closeSocketSessions(socket);
    });
  }

  listSessions(): TerminalSessionSummary[] {
    return [...this.sessions.values()]
      .map((session) => session.summary)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  getPlainText(id: string, tailLines: number): string {
    return extractPlainText(this.requireSession(id).headless, tailLines);
  }

  getInputSnapshot(id: string, tailLines: number): SessionInputSnapshot {
    const session = this.requireSession(id);
    return {
      session: session.summary,
      text: extractPlainText(session.headless, tailLines),
      modes: readTerminalModes(session.headless)
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
      session: session.summary
    };
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
      session: session.summary,
      screen,
      transcript: chunks.map((chunk) => chunk.data).join(""),
      chunks
    };
  }

  write(id: string, data: string): void {
    const session = this.requireSession(id);
    if (session.summary.status !== "running") {
      return;
    }
    send(session.socket, { type: "input", sessionId: id, data });
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.requireSession(id);
    if (session.summary.status !== "running") {
      return;
    }

    const nextCols = clampCols(cols);
    const nextRows = clampRows(rows);

    if (session.summary.cols === nextCols && session.summary.rows === nextRows) {
      return;
    }

    session.summary = {
      ...session.summary,
      cols: nextCols,
      rows: nextRows,
      updatedAt: new Date().toISOString()
    };
    session.headless.resize(nextCols, nextRows);
    send(session.socket, { type: "resize", sessionId: id, cols: nextCols, rows: nextRows });
    this.emit("session", session.summary);
  }

  kill(id: string): void {
    const session = this.requireSession(id);
    if (session.summary.status === "running") {
      send(session.socket, { type: "kill", sessionId: id });
      return;
    }

    this.sessions.delete(id);
    this.socketSessions.get(session.socket)?.delete(id);
    session.headless.dispose();
    this.emit("sessions", this.listSessions());
  }

  rename(id: string, title: string): TerminalSessionSummary {
    const session = this.requireSession(id);
    const nextTitle = cleanTitle(title);
    if (nextTitle) {
      session.summary = {
        ...session.summary,
        title: nextTitle,
        updatedAt: new Date().toISOString()
      };
      this.emit("session", session.summary);
      this.emit("sessions", this.listSessions());
    }
    return session.summary;
  }

  private handleMessage(socket: WebSocket, message: BridgeClientMessage): void {
    switch (message.type) {
      case "register":
        this.register(socket, message.session, message.replay);
        break;
      case "output":
        this.appendOutput(message.sessionId, message.data);
        break;
      case "resize":
        this.resizeFromBridge(message.sessionId, message.cols, message.rows);
        break;
      case "title":
        this.setTitle(message.sessionId, message.title);
        break;
      case "project":
        this.assignProject(message.sessionId, message.projectId);
        break;
      case "exit":
        this.exit(message.sessionId, message.exitCode, message.signal);
        break;
    }
  }

  private setTitle(id: string, title: string): void {
    const session = this.sessions.get(id);
    const nextTitle = cleanTitle(title);
    if (!session || !nextTitle || session.summary.title === nextTitle) {
      return;
    }

    session.summary = {
      ...session.summary,
      title: nextTitle,
      updatedAt: new Date().toISOString()
    };
    this.emit("session", session.summary);
  }

  updateAgentObservation(id: string, observation: TerminalAgentObservation): TerminalSessionSummary | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }

    if (!updateTerminalAgentObservation(session, observation)) {
      return session.summary;
    }

    session.summary = withAgentMetadata(session.summary, session);
    this.emit("session", session.summary);
    return session.summary;
  }

  assignProject(id: string, projectId?: string): TerminalSessionSummary | undefined {
    const session = this.sessions.get(id);
    if (!session || session.summary.projectId === projectId) {
      return session?.summary;
    }

    session.summary = {
      ...session.summary,
      projectId,
      updatedAt: new Date().toISOString()
    };
    this.emit("session", session.summary);
    return session.summary;
  }

  updateCwd(id: string, cwd: string): TerminalSessionSummary | undefined {
    const session = this.sessions.get(id);
    const trimmed = cwd.trim();
    if (!session || !trimmed) {
      return session?.summary;
    }

    const resolved = path.resolve(trimmed);
    const unchanged = process.platform === "win32" ? session.summary.cwd.toLowerCase() === resolved.toLowerCase() : session.summary.cwd === resolved;
    if (unchanged) {
      return session.summary;
    }

    session.summary = {
      ...session.summary,
      cwd: resolved,
      updatedAt: new Date().toISOString()
    };
    this.emit("session", session.summary);
    this.emit("sessions", this.listSessions());
    return session.summary;
  }

  updateAgentPresence(id: string, event: Omit<TerminalAgentPresenceEvent, "sessionId">): TerminalSessionSummary | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }

    if (!updateTerminalAgentPresence(session, event)) {
      return session.summary;
    }

    session.summary = withAgentMetadata({ ...session.summary, updatedAt: new Date().toISOString() }, session);
    this.emit("session", session.summary);
    this.emit("sessions", this.listSessions());
    return session.summary;
  }

  private register(socket: WebSocket, summary: TerminalSessionSummary, replay?: string): void {
    const now = new Date().toISOString();
    const cols = clampCols(summary.cols);
    const rows = clampRows(summary.rows);
    const existing = this.sessions.get(summary.id);
    const launch = classifyLaunch(summary);

    if (existing) {
      if (existing.summary.status === "running" && existing.socket.readyState === WebSocket.OPEN) {
        throw new Error(`Bridge session already exists: ${summary.id}`);
      }

      existing.socket = socket;
      existing.baseAgent = launch.agent;
      existing.baseAgentSource = launch.source;
      existing.summary = withAgentMetadata({
        ...existing.summary,
        ...summary,
        cwd: path.resolve(summary.cwd),
        source: "bridged",
        status: "running",
        updatedAt: now,
        cols,
        rows,
        exitCode: undefined,
        signal: undefined,
        bufferedBytes: existing.bufferedBytes
      }, existing);
      existing.headless.resize(cols, rows);
      this.addSocketSession(socket, existing.summary.id);

      send(socket, { type: "registered", session: existing.summary, replay: false });
      this.emit("session", existing.summary);
      this.emit("sessions", this.listSessions());
      return;
    }

    const headless = new HeadlessTerminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 5000
    });
    const serializer = new SerializeAddon();
    headless.loadAddon(serializer);

    const normalized: TerminalSessionSummary = withAgentMetadata({
      ...summary,
      cwd: path.resolve(summary.cwd),
      source: "bridged",
      status: "running",
      createdAt: summary.createdAt || now,
      updatedAt: now,
      cols,
      rows,
      bufferedBytes: 0
    }, { baseAgent: launch.agent, baseAgentSource: launch.source });

    const bridged: BridgedSession = {
      summary: normalized,
      socket,
      headless,
      serializer,
      seq: 0,
      transcript: [],
      bufferedBytes: 0,
      baseAgent: launch.agent,
      baseAgentSource: launch.source
    };

    this.sessions.set(normalized.id, bridged);
    this.addSocketSession(socket, normalized.id);

    // A native client can include its bounded recent output with a fresh
    // registration after this server restarts. Replaying before the session is
    // announced restores the rendered question, runtime agent OSC, and input
    // modes without duplicating output when the old registry still exists.
    const boundedReplay = typeof replay === "string" ? replay.slice(-512_000) : "";
    if (boundedReplay) this.appendOutput(normalized.id, boundedReplay, true);
    const registered = this.sessions.get(normalized.id)!.summary;
    send(socket, { type: "registered", session: registered, replay: !boundedReplay });
    this.emit("session", registered);
    this.emit("sessions", this.listSessions());
  }

  private addSocketSession(socket: WebSocket, id: string): void {
    const socketSessionIds = this.socketSessions.get(socket) ?? new Set<string>();
    socketSessionIds.add(id);
    this.socketSessions.set(socket, socketSessionIds);
  }

  private appendOutput(id: string, data: string, replay = false): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    const now = new Date().toISOString();
    session.seq += 1;
    session.headless.write(data);

    const chunk: TranscriptChunk = {
      seq: session.seq,
      data,
      at: now
    };

    session.transcript.push(chunk);
    session.bufferedBytes += byteLength(data);

    while (session.bufferedBytes > MAX_TRANSCRIPT_BYTES && session.transcript.length > 1) {
      const removed = session.transcript.shift();
      if (removed) {
        session.bufferedBytes -= byteLength(removed.data);
      }
    }

    session.summary = {
      ...session.summary,
      updatedAt: now,
      bufferedBytes: session.bufferedBytes
    };

    this.emit("output", {
      sessionId: id,
      seq: session.seq,
      data,
      replay
    });
  }

  private resizeFromBridge(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }

    const nextCols = clampCols(cols);
    const nextRows = clampRows(rows);

    if (session.summary.cols === nextCols && session.summary.rows === nextRows) {
      return;
    }

    session.summary = {
      ...session.summary,
      cols: nextCols,
      rows: nextRows,
      updatedAt: new Date().toISOString()
    };
    session.headless.resize(nextCols, nextRows);
    this.emit("session", session.summary);
  }

  private exit(id: string, exitCode?: number, signal?: number): void {
    const session = this.sessions.get(id);
    if (!session || session.summary.status === "exited") {
      return;
    }

    session.summary = {
      ...session.summary,
      status: "exited",
      updatedAt: new Date().toISOString(),
      exitCode,
      signal
    };

    this.emit("exit", {
      sessionId: id,
      exitCode,
      signal,
      session: session.summary
    });
    this.emit("sessions", this.listSessions());

    // The session list should mirror live terminal tabs: drop exited
    // sessions after a grace period. The grace period lets a restarting
    // terminal re-register under the same id (which flips it back to
    // running) without losing its transcript.
    const timer = setTimeout(() => {
      const current = this.sessions.get(id);
      if (current && current.summary.status === "exited") {
        this.sessions.delete(id);
        this.socketSessions.get(current.socket)?.delete(id);
        current.headless.dispose();
        this.emit("sessions", this.listSessions());
      }
    }, 30_000);
    timer.unref?.();
  }

  private closeSocketSessions(socket: WebSocket): void {
    const ids = this.socketSessions.get(socket);
    if (!ids) {
      return;
    }

    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session?.socket === socket) {
        this.exit(id);
      }
    }
  }

  private requireSession(id: string): BridgedSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown bridged terminal session: ${id}`);
    }
    return session;
  }
}
