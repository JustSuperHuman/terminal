export type SessionStatus = "running" | "exited";
export type SessionSource = "managed" | "bridged";
export type TerminalAgentId = "claude" | "codex" | "hermes";
export type TerminalAgentSource = "profile" | "command" | "screen" | "osc";
export type TerminalAgentActivity = "idle" | "working" | "awaiting";

export interface TerminalProfile {
  id: string;
  label: string;
  shell: string;
  args: string[];
  group: "shell" | "agent" | "custom";
  description?: string;
  agent?: TerminalAgentId;
  terminalProfileGuid?: string;
}

export interface TerminalProject {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  /** Present for projects inferred from a live terminal's current directory. */
  automatic?: boolean;
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
  /** Terminal Assist classification only; real ACP sessions use the ACP state contract. */
  agent?: TerminalAgentId;
  agentSource?: TerminalAgentSource;
  agentActivity?: TerminalAgentActivity;
  acpSessionId?: string;
  /** Special sessions (the orchestrator) are hidden from the normal session list. */
  kind?: "orchestrator";
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

export type OrchestratorAgent = "claude" | "codex";

export interface OrchestratorStatus {
  state: "stopped" | "starting" | "running";
  agent?: OrchestratorAgent;
  sessionId?: string;
  startedAt?: string;
  lastExit?: { exitCode?: number; signal?: number; at: string };
  availableAgents: OrchestratorAgent[];
}

export interface BootstrapPayload {
  sessions: TerminalSessionSummary[];
  profiles: TerminalProfile[];
  hostProcesses: HostTerminalProcess[];
  peerHosts: TerminalHostPeer[];
  projects: TerminalProject[];
  server: ServerInfo;
  bridgeCommands: BridgeCommandInfo;
  orchestrator?: OrchestratorStatus;
}

export interface CreateSessionOptions {
  title?: string;
  profileId?: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  projectId?: string;
}

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
      orchestrator?: OrchestratorStatus;
    }
  | { type: "sessions"; sessions: TerminalSessionSummary[] }
  | { type: "profiles"; profiles: TerminalProfile[] }
  | { type: "projects"; projects: TerminalProject[] }
  | { type: "orchestrator"; orchestrator: OrchestratorStatus }
  | { type: "notify"; title?: string; body?: string; sound?: string }
  | { type: "session"; session: TerminalSessionSummary }
  | { type: "snapshot"; sessionId: string; screen?: string; chunks: TranscriptChunk[]; session: TerminalSessionSummary }
  | { type: "output"; sessionId: string; seq: number; data: string }
  // Data-free "this session printed something" ping sent (throttled) instead
  // of full output to clients not subscribed to the session.
  | { type: "activity"; sessionId: string; seq: number }
  | { type: "exit"; sessionId: string; exitCode?: number; signal?: number; session: TerminalSessionSummary }
  | { type: "host"; hostProcesses: HostTerminalProcess[]; peerHosts: TerminalHostPeer[] }
  | { type: "error"; message: string; detail?: string };

export type ClientMessage =
  // Slots let one client watch several sessions at once (main terminal +
  // orchestrator panel); subscribing replaces only the caller's slot.
  | { type: "subscribe"; sessionId: string; slot?: string }
  | { type: "unsubscribe"; slot?: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | ({ type: "create" } & CreateSessionOptions)
  | { type: "rename"; sessionId: string; title: string }
  | { type: "kill"; sessionId: string }
  | { type: "refresh-host" };
