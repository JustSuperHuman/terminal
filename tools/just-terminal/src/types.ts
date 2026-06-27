// Protocol types shared with the Terminal Web host
// (tools/terminal-web/src/lib/types.ts). Mobile only consumes the subset it
// needs: managed/bridged local sessions, launch profiles, and the live
// WebSocket message stream. Peer hosts, host processes, bridge commands, and
// access URLs from the web sidebar are intentionally omitted.

export type SessionStatus = "running" | "exited";
export type SessionSource = "managed" | "bridged";

export interface TerminalProfile {
  id: string;
  label: string;
  shell: string;
  args: string[];
  group: "shell" | "agent" | "custom";
  description?: string;
}

export interface TerminalSessionSummary {
  id: string;
  title: string;
  shell: string;
  args: string[];
  cwd: string;
  source: SessionSource;
  pid?: number;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  cols: number;
  rows: number;
  exitCode?: number;
  signal?: number;
  bufferedBytes: number;
}

export interface TranscriptChunk {
  seq: number;
  data: string;
  at: string;
}

export interface ServerInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  urls: unknown[];
}

export type ServerMessage =
  | {
      type: "hello";
      sessions: TerminalSessionSummary[];
      profiles: TerminalProfile[];
      hostProcesses: unknown[];
      peerHosts: unknown[];
      server: ServerInfo;
      bridgeCommands: unknown;
    }
  | { type: "sessions"; sessions: TerminalSessionSummary[] }
  | { type: "session"; session: TerminalSessionSummary }
  | { type: "snapshot"; sessionId: string; screen?: string; chunks: TranscriptChunk[]; session: TerminalSessionSummary }
  | { type: "output"; sessionId: string; seq: number; data: string }
  | { type: "exit"; sessionId: string; exitCode?: number; signal?: number; session: TerminalSessionSummary }
  | { type: "host"; hostProcesses: unknown[]; peerHosts: unknown[] }
  | { type: "error"; message: string; detail?: string };

export type ClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "create"; title?: string; profileId?: string; shell?: string; args?: string[]; cwd?: string }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "kill"; sessionId: string }
  | { type: "refresh-host" };
