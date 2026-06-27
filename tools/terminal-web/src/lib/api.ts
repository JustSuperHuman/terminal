import type { BootstrapPayload, TerminalSessionSummary } from "./types";
import { accessTokenHeaders, withAccessToken } from "./access-token";

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getBootstrap(): Promise<BootstrapPayload> {
  return parseResponse<BootstrapPayload>(await fetch(withAccessToken("/api/bootstrap"), { headers: accessTokenHeaders() }));
}

export async function createSession(profileId?: string): Promise<TerminalSessionSummary> {
  return parseResponse<TerminalSessionSummary>(
    await fetch(withAccessToken("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...accessTokenHeaders() },
      body: JSON.stringify({ profileId })
    })
  );
}
