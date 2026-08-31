import { apiUrl, type ServerEndpoint } from "./endpoint";

// Client for the host's composer endpoints (tools/terminal-web/server:
// session-input.ts, slash-commands.ts, file-search.ts). The phone cannot see
// the host filesystem or the agent's own popups, so everything the composer
// needs to be smart about a session is asked for over REST.

export type AgentKind = "claude" | "codex" | "shell" | "unknown";

export interface SessionPromptOption {
  id: string;
  key?: string;
  label: string;
  description?: string;
  focused: boolean;
  selected: boolean;
  disabled: boolean;
  custom: boolean;
}

export interface SessionPrompt {
  id: string;
  kind: "single-select" | "multi-select" | "confirm" | "freeform";
  interaction: "direct-key" | "cursor" | "numeric-input";
  title?: string;
  question?: string;
  details: string[];
  options: SessionPromptOption[];
  progress?: { current: number; total: number; unanswered?: number };
  textInput?: { kind: "answer" | "other" | "notes"; placeholder: string; optional: boolean };
  acceptsNotes: boolean;
  canSubmit: boolean;
  submitLabel?: string;
  submitTarget?: { index: number; focused: boolean };
  cancelLabel: "Cancel" | "Interrupt";
}

export type SessionPromptResponse =
  | { action: "select" | "toggle"; optionId: string }
  | { action: "submit"; optionIds?: string[] }
  | { action: "text"; text: string }
  | { action: "open-notes" }
  | { action: "cancel" };

export interface SessionInputContext {
  sessionId: string;
  agent: AgentKind;
  agentLabel: string;
  cwd: string;
  status: "running" | "exited";
  altScreen: boolean;
  bracketedPaste: boolean;
  /** Deliver composed text as a bracketed paste (see the host's session-input). */
  pasteSafe: boolean;
  applicationCursor: boolean;
  mouse: boolean;
  busy: boolean;
  prompt?: SessionPrompt;
  at: string;
}

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  source: "builtin" | "project" | "user";
}

export interface FileHit {
  path: string;
  name: string;
  dir: string;
  kind: "file" | "dir";
}

const DEFAULT_TIMEOUT_MS = 6000;

function authHeaders(endpoint: ServerEndpoint): Record<string, string> {
  return endpoint.token ? { "x-terminal-web-token": endpoint.token } : {};
}

async function getJson<T>(endpoint: ServerEndpoint, path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort);
  try {
    const response = await fetch(apiUrl(endpoint, path), {
      headers: authHeaders(endpoint),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${path} failed (${response.status})`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Which agent is listening, whether it is busy, and any menu it is blocking on. */
export function fetchInputContext(
  endpoint: ServerEndpoint,
  sessionId: string,
  signal?: AbortSignal
): Promise<SessionInputContext> {
  return getJson<SessionInputContext>(endpoint, `/api/sessions/${encodeURIComponent(sessionId)}/input-context`, signal);
}

/** The agent's built-in slash commands plus the project's and user's own. */
export function fetchSlashCommands(
  endpoint: ServerEndpoint,
  sessionId: string,
  signal?: AbortSignal
): Promise<{ agent: AgentKind; agentLabel: string; cwd: string; commands: SlashCommand[] }> {
  return getJson(endpoint, `/api/sessions/${encodeURIComponent(sessionId)}/commands`, signal);
}

/** Fuzzy file lookup under the session's working directory, for `@` mentions. */
export async function searchSessionFiles(
  endpoint: ServerEndpoint,
  sessionId: string,
  query: string,
  signal?: AbortSignal
): Promise<FileHit[]> {
  const result = await getJson<{ cwd: string; files: FileHit[] }>(
    endpoint,
    `/api/sessions/${encodeURIComponent(sessionId)}/files?limit=40&q=${encodeURIComponent(query)}`,
    signal
  );
  return result.files;
}

export interface ComposeResult {
  method: "paste" | "raw" | "none";
  submitted: boolean;
}

export class PromptResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stale: boolean
  ) {
    super(message);
    this.name = "PromptResponseError";
  }
}

/**
 * Answer the exact prompt currently rendered in the terminal. The host checks
 * `promptId` again immediately before sending any keys, so a stale mobile card
 * cannot answer whatever dialog appeared after it.
 */
export async function respondToPrompt(
  endpoint: ServerEndpoint,
  sessionId: string,
  promptId: string,
  response: SessionPromptResponse
): Promise<{ accepted: true; promptId: string; action: SessionPromptResponse["action"] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const result = await fetch(apiUrl(endpoint, `/api/sessions/${encodeURIComponent(sessionId)}/prompt-response`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(endpoint) },
      body: JSON.stringify({ promptId, ...response }),
      signal: controller.signal,
    });
    if (!result.ok) {
      const payload = (await result.json().catch(() => undefined)) as { message?: string; stale?: boolean } | undefined;
      throw new PromptResponseError(payload?.message ?? `Could not answer (${result.status})`, result.status, payload?.stale === true);
    }
    return (await result.json()) as { accepted: true; promptId: string; action: SessionPromptResponse["action"] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver a composed message. The host decides the envelope — bracketed paste
 * when the running program enabled it, so a multi-line prompt arrives as one
 * prompt instead of executing line by line — and paces the write.
 */
export async function composeInput(
  endpoint: ServerEndpoint,
  sessionId: string,
  options: { text: string; submit: boolean }
): Promise<ComposeResult> {
  const controller = new AbortController();
  // Long messages are written in paced chunks host-side, so allow more time
  // than a plain GET.
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(apiUrl(endpoint, `/api/sessions/${encodeURIComponent(sessionId)}/compose`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(endpoint) },
      body: JSON.stringify({ text: options.text, submit: options.submit }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Send failed (${response.status})`);
    }
    return (await response.json()) as ComposeResult;
  } finally {
    clearTimeout(timer);
  }
}
