import type {
  AcpAgentId,
  AcpBridgeState,
  AcpPromptBlockInput,
  AcpSessionView,
} from "../acpTypes";
import { apiUrl, type ServerEndpoint } from "./endpoint";

export interface CreateAcpSessionInput {
  agent: AcpAgentId;
  cwd: string;
  additionalDirectories?: string[];
}

export interface LoadAcpSessionInput {
  agent: AcpAgentId;
  sessionId: string;
  cwd: string;
  mode: "load" | "resume";
}

export interface RespondToAcpRequestInput {
  action: string;
  optionId?: string;
  content?: unknown;
}

export interface AcpGoalActionInput {
  action: string;
  objective?: string;
}

interface AcpMutationEnvelope {
  session?: AcpSessionView;
  state?: AcpBridgeState;
}

function authHeaders(endpoint: ServerEndpoint): Record<string, string> {
  return endpoint.token ? { "x-terminal-web-token": endpoint.token } : {};
}

async function readError(response: Response): Promise<string> {
  const fallback = `ACP request failed (${response.status})`;
  try {
    const text = await response.text();
    if (!text.trim()) return fallback;
    try {
      const body = JSON.parse(text) as { message?: unknown; detail?: unknown; error?: unknown };
      const message = [body.message, body.detail, body.error].find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (message) return `${fallback}: ${message}`;
    } catch {
      // Plain-text errors are still useful to the person holding the phone.
    }
    return `${fallback}: ${text.trim().slice(0, 400)}`;
  } catch {
    return fallback;
  }
}

async function request<T>(
  endpoint: ServerEndpoint,
  path: string,
  init: RequestInit = {}
): Promise<T | undefined> {
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
    throw new Error(await readError(response));
  }
  if (response.status === 204) {
    return undefined;
  }
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("The ACP host returned an invalid JSON response.");
  }
}

function sessionFromMutation(value: AcpSessionView | AcpMutationEnvelope | undefined): AcpSessionView | undefined {
  if (!value) return undefined;
  if ("id" in value) return value;
  return value.session;
}

export async function fetchAcpState(endpoint: ServerEndpoint): Promise<AcpBridgeState> {
  const state = await request<AcpBridgeState>(endpoint, "/api/acp");
  if (!state || typeof state.epoch !== "string" || typeof state.sequence !== "number" || !Array.isArray(state.agents) || !Array.isArray(state.sessions) || !Array.isArray(state.requests)) {
    throw new Error("The ACP host returned an incomplete state snapshot.");
  }
  return state;
}

export async function startAcpAgent(endpoint: ServerEndpoint, agent: AcpAgentId): Promise<void> {
  await request<unknown>(endpoint, `/api/acp/agents/${encodeURIComponent(agent)}/start`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function authenticateAcpAgent(
  endpoint: ServerEndpoint,
  agent: AcpAgentId,
  methodId: string
): Promise<void> {
  await request<unknown>(endpoint, `/api/acp/agents/${encodeURIComponent(agent)}/authenticate`, {
    method: "POST",
    body: JSON.stringify({ methodId }),
  });
}

export async function logoutAcpAgent(endpoint: ServerEndpoint, agent: AcpAgentId): Promise<void> {
  await request<unknown>(endpoint, `/api/acp/agents/${encodeURIComponent(agent)}/logout`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function createAcpSession(
  endpoint: ServerEndpoint,
  input: CreateAcpSessionInput
): Promise<AcpSessionView | undefined> {
  const result = await request<AcpSessionView | AcpMutationEnvelope>(endpoint, "/api/acp/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return sessionFromMutation(result);
}

export async function loadAcpSession(
  endpoint: ServerEndpoint,
  input: LoadAcpSessionInput
): Promise<AcpSessionView | undefined> {
  const result = await request<AcpSessionView | AcpMutationEnvelope>(endpoint, "/api/acp/sessions/load", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return sessionFromMutation(result);
}

export async function forkAcpSession(
  endpoint: ServerEndpoint,
  sessionId: string,
  cwd?: string
): Promise<AcpSessionView | undefined> {
  const result = await request<AcpSessionView | AcpMutationEnvelope>(
    endpoint,
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/fork`,
    { method: "POST", body: JSON.stringify(cwd ? { cwd } : {}) }
  );
  return sessionFromMutation(result);
}

export async function promptAcpSession(
  endpoint: ServerEndpoint,
  sessionId: string,
  content: AcpPromptBlockInput[],
  options: { reportFileChanges?: boolean } = {}
): Promise<void> {
  await request<unknown>(endpoint, `/api/acp/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ content, ...(options.reportFileChanges !== undefined ? { reportFileChanges: options.reportFileChanges } : {}) }),
  });
}

export async function cancelAcpSession(endpoint: ServerEndpoint, sessionId: string): Promise<void> {
  await request<unknown>(endpoint, `/api/acp/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function setAcpSessionConfig(
  endpoint: ServerEndpoint,
  sessionId: string,
  configId: string,
  value: string | boolean,
  confirmDangerous = false
): Promise<void> {
  await request<unknown>(
    endpoint,
    `/api/acp/sessions/${encodeURIComponent(sessionId)}/config/${encodeURIComponent(configId)}`,
    { method: "PATCH", body: JSON.stringify({ value, ...(confirmDangerous ? { confirmDangerous: true } : {}) }) }
  );
}

export async function setAcpSessionMode(
  endpoint: ServerEndpoint,
  sessionId: string,
  modeId: string,
  confirmDangerous = false
): Promise<void> {
  await request<unknown>(endpoint, `/api/acp/sessions/${encodeURIComponent(sessionId)}/mode`, {
    method: "PATCH",
    body: JSON.stringify({ modeId, ...(confirmDangerous ? { confirmDangerous: true } : {}) }),
  });
}

export async function actOnAcpGoal(
  endpoint: ServerEndpoint,
  sessionId: string,
  input: AcpGoalActionInput
): Promise<void> {
  await request<unknown>(endpoint, `/api/acp/sessions/${encodeURIComponent(sessionId)}/goal`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function closeAcpSession(endpoint: ServerEndpoint, sessionId: string): Promise<void> {
  await request<unknown>(endpoint, `/api/acp/sessions/${encodeURIComponent(sessionId)}/close`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function deleteAcpSession(endpoint: ServerEndpoint, sessionId: string): Promise<void> {
  await request<unknown>(endpoint, `/api/acp/sessions/${encodeURIComponent(sessionId)}?deleteRemote=1`, { method: "DELETE" });
}

export async function respondToAcpRequest(
  endpoint: ServerEndpoint,
  requestId: string,
  response: RespondToAcpRequestInput
): Promise<void> {
  await request<unknown>(endpoint, `/api/acp/requests/${encodeURIComponent(requestId)}/respond`, {
    method: "POST",
    body: JSON.stringify(response),
  });
}
