// Turns a user-typed server address into the concrete HTTP + WebSocket URLs the
// Terminal Web host expects. Accepts forms like:
//   192.168.1.5:10001
//   http://192.168.1.5:10001
//   http://host:10001/?token=abc
//   https://host:10001  (with a separate token)

export const DEFAULT_PORT = 10001;

export interface ServerEndpoint {
  /** Canonical id used for storage + dedupe, e.g. "http://192.168.1.5:10001". */
  id: string;
  /** Origin for REST calls, e.g. "http://192.168.1.5:10001". */
  httpBase: string;
  /** WebSocket URL for the control/terminal stream, token included. */
  wsUrl: string;
  /** Host:port shown in the UI. */
  host: string;
  /** Access token, if any. */
  token?: string;
  /** Friendly label the user can set. */
  label?: string;
}

export interface ParsedAddress {
  httpBase: string;
  host: string;
  secure: boolean;
  token?: string;
}

/** Parse a free-form address. Returns null when it cannot be understood. */
export function parseAddress(raw: string): ParsedAddress | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (!url.hostname) {
    return null;
  }

  const secure = url.protocol === "https:";
  const port = url.port || String(DEFAULT_PORT);
  const host = `${url.hostname}:${port}`;
  const token = url.searchParams.get("token") ?? url.searchParams.get("access_token") ?? undefined;

  return {
    httpBase: `${url.protocol}//${host}`,
    host,
    secure,
    token: token || undefined,
  };
}

export function buildEndpoint(raw: string, explicitToken?: string, label?: string): ServerEndpoint | null {
  const parsed = parseAddress(raw);
  if (!parsed) {
    return null;
  }

  const token = (explicitToken && explicitToken.trim()) || parsed.token;
  const wsScheme = parsed.secure ? "wss" : "ws";
  const wsBase = `${wsScheme}://${parsed.host}/ws`;
  const wsUrl = token ? `${wsBase}?token=${encodeURIComponent(token)}` : wsBase;

  return {
    id: parsed.httpBase,
    httpBase: parsed.httpBase,
    wsUrl,
    host: parsed.host,
    token: token || undefined,
    label: label?.trim() || undefined,
  };
}

/** Append the access token to a REST path on this endpoint. */
export function apiUrl(endpoint: ServerEndpoint, path: string): string {
  const base = `${endpoint.httpBase}${path.startsWith("/") ? path : `/${path}`}`;
  if (!endpoint.token) {
    return base;
  }
  const join = base.includes("?") ? "&" : "?";
  return `${base}${join}token=${encodeURIComponent(endpoint.token)}`;
}
