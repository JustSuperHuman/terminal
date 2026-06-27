import { apiUrl, type ServerEndpoint } from "./endpoint";
import type { TerminalSessionSummary } from "../types";

export interface CreateSessionOptions {
  profileId?: string;
  shell?: string;
  args?: string[];
  title?: string;
  cwd?: string;
}

function authHeaders(endpoint: ServerEndpoint): Record<string, string> {
  return endpoint.token ? { "x-terminal-web-token": endpoint.token } : {};
}

/**
 * Create a session via REST. The host's POST /api/sessions forwards the whole
 * body to the terminal manager, so custom shell/args/title are honored and the
 * created session summary is returned (used to auto-select it).
 */
export async function createSession(
  endpoint: ServerEndpoint,
  options: CreateSessionOptions
): Promise<TerminalSessionSummary> {
  const response = await fetch(apiUrl(endpoint, "/api/sessions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(endpoint) },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    throw new Error(`Create session failed (${response.status})`);
  }
  return (await response.json()) as TerminalSessionSummary;
}

/** Lightweight reachability probe used by the connect screen. */
export async function probeServer(endpoint: ServerEndpoint, timeoutMs = 6000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(endpoint, "/api/bootstrap"), {
      headers: authHeaders(endpoint),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
