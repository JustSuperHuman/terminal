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

export interface TerminalProject {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
}

export interface RecentProject {
  name: string;
  cwd: string;
  closedAt: string;
}

export interface TerminalSessionSummary {
  id: string;
  title: string;
  shell: string;
  args: string[];
  cwd: string;
  projectId?: string;
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

export interface TerminalSessionExport {
  session: TerminalSessionSummary;
  screen?: string;
  transcript: string;
  chunks: TranscriptChunk[];
}

export interface HostTerminalProcess {
  pid: number;
  ppid?: number;
  name: string;
  commandLine?: string;
  executablePath?: string;
  attachable: false;
  reason: string;
}

export interface ServerInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  urls: ServerAccessUrl[];
}

export interface ServerAccessUrl {
  label: string;
  address: string;
  url: string;
  scope: "local" | "network";
  tokenRequired: boolean;
}

export interface TerminalHostPeer {
  id: string;
  url: string;
  server: ServerInfo;
  sessions: TerminalSessionSummary[];
  profiles: TerminalProfile[];
  reachable: true;
}

export interface BridgeCommandInfo {
  serverUrl: string;
  shell: string;
  codex?: string;
  claude?: string;
}

export type ClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "create"; title?: string; profileId?: string; shell?: string; args?: string[]; cwd?: string; projectId?: string }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "kill"; sessionId: string }
  | { type: "refresh-host" };

export interface NotifyPayload {
  title?: string;
  body?: string;
  sound?: string;
}

export type BridgeClientMessage =
  | { type: "register"; session: TerminalSessionSummary }
  | { type: "output"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "title"; sessionId: string; title: string }
  | { type: "project"; sessionId: string; projectId?: string }
  | { type: "exit"; sessionId: string; exitCode?: number; signal?: number };

export type BridgeServerMessage =
  | { type: "registered"; session: TerminalSessionSummary; replay?: boolean }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "kill"; sessionId: string }
  | { type: "error"; message: string; detail?: string };

export type ServerMessage =
  | {
      type: "hello";
      sessions: TerminalSessionSummary[];
      profiles: TerminalProfile[];
      hostProcesses: HostTerminalProcess[];
      peerHosts: TerminalHostPeer[];
      projects: TerminalProject[];
      server: ServerInfo;
      bridgeCommands: BridgeCommandInfo;
    }
  | { type: "sessions"; sessions: TerminalSessionSummary[] }
  | { type: "projects"; projects: TerminalProject[] }
  | { type: "notify"; title?: string; body?: string; sound?: string }
  | { type: "session"; session: TerminalSessionSummary }
  | { type: "snapshot"; sessionId: string; screen?: string; chunks: TranscriptChunk[]; session: TerminalSessionSummary }
  | { type: "output"; sessionId: string; seq: number; data: string }
  // Data-free "this session printed something" ping sent (throttled) instead
  // of full output to clients not subscribed to the session; drives unread
  // badges without streaming every session's bytes to every client.
  | { type: "activity"; sessionId: string; seq: number }
  | { type: "exit"; sessionId: string; exitCode?: number; signal?: number; session: TerminalSessionSummary }
  | { type: "host"; hostProcesses: HostTerminalProcess[]; peerHosts: TerminalHostPeer[] }
  | { type: "error"; message: string; detail?: string };
