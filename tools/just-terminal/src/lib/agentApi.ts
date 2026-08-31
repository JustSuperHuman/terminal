import type { AcpAgentId, AcpSessionView } from "../acpTypes";
import type { TerminalAgentActivity, TerminalAgentSource, TerminalSessionSummary } from "../types";
import { apiUrl, type ServerEndpoint } from "./endpoint";

/**
 * One conversation this terminal could open a rich agent view onto.
 *
 * ACP cannot attach to the harness process already running in the terminal, so
 * the host ranks the agent's own conversation history by working directory and
 * recency and lets the person choose. `exact` marks a same-directory match.
 */
export interface AgentLinkCandidate {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  exact: boolean;
}

export interface SessionAgentState {
  sessionId: string;
  agent?: AcpAgentId;
  agentSource?: TerminalAgentSource;
  activity?: TerminalAgentActivity;
  acpSessionId?: string;
  acpSession?: AcpSessionView;
  attach: {
    supported: boolean;
    agentState?: "stopped" | "starting" | "ready" | "error";
    reason?: string;
    candidates: AgentLinkCandidate[];
  };
}

export interface AttachSessionAgentInput {
  /** Continue an existing conversation. Omit to start a fresh one in the cwd. */
  remoteSessionId?: string;
  cwd?: string;
  agent?: AcpAgentId;
}

export interface AttachSessionAgentResult {
  session: TerminalSessionSummary;
  acpSession: AcpSessionView;
}

function authHeaders(endpoint: ServerEndpoint): Record<string, string> {
  return endpoint.token ? { "x-terminal-web-token": endpoint.token } : {};
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    if (!text.trim()) return fallback;
    try {
      const body = JSON.parse(text) as { message?: unknown; detail?: unknown };
      const message = [body.message, body.detail].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      );
      if (message) return message;
    } catch {
      // A plain-text error is still the most useful thing to show.
    }
    return text.trim().slice(0, 300);
  } catch {
    return fallback;
  }
}

async function request<T>(endpoint: ServerEndpoint, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(endpoint, path), {
    ...init,
    headers: {
      Accept: "application/json",
      ...authHeaders(endpoint),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(await readError(response, `Agent request failed (${response.status})`));
  }
  return (await response.json()) as T;
}

/**
 * What is running in this terminal and what a rich view would cost. Safe to
 * call on any session; a plain shell simply answers with no agent.
 *
 * `prepare` starts the agent's ACP adapter so its past conversations can be
 * listed. Pass it for a deliberate tap and leave it off for background polling
 * — a stopped adapter otherwise reports no history at all.
 */
export function fetchSessionAgent(
  endpoint: ServerEndpoint,
  sessionId: string,
  prepare = false
): Promise<SessionAgentState> {
  return request<SessionAgentState>(
    endpoint,
    `/api/sessions/${encodeURIComponent(sessionId)}/agent${prepare ? "?prepare=1" : ""}`
  );
}

/** Open the agent view for this terminal. The terminal itself keeps running. */
export function attachSessionAgent(
  endpoint: ServerEndpoint,
  sessionId: string,
  input: AttachSessionAgentInput = {}
): Promise<AttachSessionAgentResult> {
  return request<AttachSessionAgentResult>(endpoint, `/api/sessions/${encodeURIComponent(sessionId)}/agent/attach`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Forget the pairing. The conversation is only ended when `close` is set. */
export function detachSessionAgent(
  endpoint: ServerEndpoint,
  sessionId: string,
  close = false
): Promise<unknown> {
  return request<unknown>(
    endpoint,
    `/api/sessions/${encodeURIComponent(sessionId)}/agent/attach${close ? "?close=1" : ""}`,
    { method: "DELETE" }
  );
}
