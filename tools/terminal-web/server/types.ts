import type { AcpBridgeState, AcpSessionView } from "./acp-types.js";

export type SessionStatus = "running" | "exited";
export type SessionSource = "managed" | "bridged";
export type TerminalAgentId = "claude" | "codex" | "hermes";
export type TerminalAgentSource = "profile" | "command" | "screen" | "osc";
/** What the foreground agent is doing right now, from its rendered screen. */
export type TerminalAgentActivity = "idle" | "working" | "awaiting";

export interface TerminalProfile {
  id: string;
  label: string;
  shell: string;
  args: string[];
  group: "shell" | "agent" | "custom";
  description?: string;
  /** Agent identity inferred from the configured command, when applicable. */
  agent?: TerminalAgentId;
  /** Native Windows Terminal profile GUID used to launch the exact profile. */
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
  /** Foreground agent when known. This enables Terminal Assist; it is not an attached ACP session. */
  agent?: TerminalAgentId;
  /** How the foreground agent was classified. OSC is a short-lived runtime override. */
  agentSource?: TerminalAgentSource;
  /** Live agent activity, so every client can show what the agent is doing without polling. */
  agentActivity?: TerminalAgentActivity;
  /** Set once the user attaches this terminal's agent to an ACP conversation. */
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

export type ClientMessage =
  // A client can watch several sessions at once through named slots (main
  // terminal + orchestrator panel); subscribing replaces only its own slot.
  | { type: "subscribe"; sessionId: string; slot?: string }
  | { type: "unsubscribe"; slot?: string }
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

export interface TerminalNotification {
  id: string;
  at: string;
  origin: "api" | "bell" | "osc";
  sessionId?: string;
  sessionTitle?: string;
  title?: string;
  body?: string;
  sound?: string;
}

export type BridgeClientMessage =
  | { type: "register"; session: TerminalSessionSummary; replay?: string }
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
      orchestrator: OrchestratorStatus;
      acp: AcpBridgeState;
    }
  | { type: "sessions"; sessions: TerminalSessionSummary[] }
  | { type: "profiles"; profiles: TerminalProfile[] }
  | { type: "projects"; projects: TerminalProject[] }
  | { type: "orchestrator"; orchestrator: OrchestratorStatus }
  | { type: "acp_state"; acp: AcpBridgeState }
  | { type: "acp_session"; epoch: string; sequence: number; session: AcpSessionView }
  | { type: "acp_session_removed"; epoch: string; sequence: number; sessionId: string }
  // The optional identity/attribution fields are additive so older clients
  // that only read title/body/sound keep working.
  | { type: "notify"; title?: string; body?: string; sound?: string; id?: string; at?: string; origin?: "api" | "bell" | "osc"; sessionId?: string; sessionTitle?: string }
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
