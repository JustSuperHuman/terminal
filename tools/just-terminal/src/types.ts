// Protocol types shared with the Terminal Web host
// (tools/terminal-web/src/lib/types.ts). Mobile only consumes the subset it
// needs: managed/bridged local sessions, launch profiles, and the live
// WebSocket message stream. Peer hosts, host processes, bridge commands, and
// access URLs from the web sidebar are intentionally omitted.

import type { AcpBridgeState, AcpSessionView } from "./acpTypes";

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
  agent?: "claude" | "codex" | "hermes";
  terminalProfileGuid?: string;
}

export interface TerminalProject {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
}

export interface TerminalSessionSummary {
  id: string;
  title: string;
  shell: string;
  args: string[];
  cwd: string;
  projectId?: string;
  /** Foreground agent when known. Direct terminals use Terminal Assist, not ACP. */
  agent?: TerminalAgentId;
  agentSource?: TerminalAgentSource;
  /** Live agent state, pushed with the session so rows never have to poll. */
  agentActivity?: TerminalAgentActivity;
  /** Present once this terminal has been attached to an ACP conversation. */
  acpSessionId?: string;
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
      projects: TerminalProject[];
      server: ServerInfo;
      bridgeCommands: unknown;
      /** Optional so a saved connection to an older bridge still opens. */
      acp?: AcpBridgeState;
    }
  | { type: "sessions"; sessions: TerminalSessionSummary[] }
  | { type: "profiles"; profiles: TerminalProfile[] }
  | { type: "projects"; projects: TerminalProject[] }
  | { type: "acp_state"; acp: AcpBridgeState }
  | { type: "acp_session"; epoch: string; sequence: number; session: AcpSessionView }
  | { type: "acp_session_removed"; epoch: string; sequence: number; sessionId: string }
  | {
      type: "notify";
      title?: string;
      body?: string;
      sound?: string;
      // Attribution fields (server ≥ notification-history): which session rang
      // and when, so the client can badge/jump and de-dupe against catch-up.
      id?: string;
      at?: string;
      origin?: "api" | "bell" | "osc";
      sessionId?: string;
      sessionTitle?: string;
    }
  | { type: "session"; session: TerminalSessionSummary }
  | { type: "snapshot"; sessionId: string; screen?: string; chunks: TranscriptChunk[]; session: TerminalSessionSummary }
  | { type: "output"; sessionId: string; seq: number; data: string }
  // Data-free "this session printed something" ping sent (throttled) instead
  // of full output to clients not subscribed to the session.
  | { type: "activity"; sessionId: string; seq: number }
  | { type: "exit"; sessionId: string; exitCode?: number; signal?: number; session: TerminalSessionSummary }
  | { type: "host"; hostProcesses: unknown[]; peerHosts: unknown[] }
  | { type: "error"; message: string; detail?: string };

// A recorded notification from GET /api/notifications (missed-signal catch-up).
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

export type ClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "input"; sessionId: string; data: string }
  | { type: "resize"; sessionId: string; cols: number; rows: number }
  | { type: "create"; title?: string; profileId?: string; shell?: string; args?: string[]; cwd?: string; projectId?: string }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "kill"; sessionId: string }
  | { type: "refresh-host" };
