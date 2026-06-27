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

export interface BootstrapPayload {
  sessions: TerminalSessionSummary[];
  profiles: TerminalProfile[];
  hostProcesses: HostTerminalProcess[];
  peerHosts: TerminalHostPeer[];
  server: ServerInfo;
  bridgeCommands: BridgeCommandInfo;
}

export type ServerMessage =
  | {
      type: "hello";
      sessions: TerminalSessionSummary[];
      profiles: TerminalProfile[];
      hostProcesses: HostTerminalProcess[];
      peerHosts: TerminalHostPeer[];
      server: ServerInfo;
      bridgeCommands: BridgeCommandInfo;
    }
  | { type: "sessions"; sessions: TerminalSessionSummary[] }
  | { type: "session"; session: TerminalSessionSummary }
  | { type: "snapshot"; sessionId: string; screen?: string; chunks: TranscriptChunk[]; session: TerminalSessionSummary }
  | { type: "output"; sessionId: string; seq: number; data: string }
  | { type: "exit"; sessionId: string; exitCode?: number; signal?: number; session: TerminalSessionSummary }
  | { type: "host"; hostProcesses: HostTerminalProcess[]; peerHosts: TerminalHostPeer[] }
  | { type: "error"; message: string; detail?: string };

export type ClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "create"; title?: string; profileId?: string; shell?: string; args?: string[]; cwd?: string }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "kill"; sessionId: string }
  | { type: "refresh-host" };
