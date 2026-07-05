import type { BootstrapPayload, CreateSessionOptions, TerminalProject, TerminalSessionSummary } from "./types";
import { accessTokenHeaders, withAccessToken } from "./access-token";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function ensureOk(response: Response): Promise<void> {
  if (!response.ok) {
    let detail = "";
    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const body = (await response.json()) as { message?: string; detail?: string };
        detail = [body.message, body.detail].filter(Boolean).join(" ");
      } else {
        detail = (await response.text()).trim();
      }
    } catch {
      detail = "";
    }
    throw new ApiError(detail || `Request failed with ${response.status}`, response.status);
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  await ensureOk(response);
  return (await response.json()) as T;
}

export async function getBootstrap(): Promise<BootstrapPayload> {
  return parseResponse<BootstrapPayload>(await fetch(withAccessToken("/api/bootstrap"), { headers: accessTokenHeaders() }));
}

export async function createSession(options: CreateSessionOptions = {}): Promise<TerminalSessionSummary> {
  return parseResponse<TerminalSessionSummary>(
    await fetch(withAccessToken("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...accessTokenHeaders() },
      body: JSON.stringify(options)
    })
  );
}

export async function createProject(name: string, cwd: string): Promise<TerminalProject> {
  return parseResponse<TerminalProject>(
    await fetch(withAccessToken("/api/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...accessTokenHeaders() },
      body: JSON.stringify({ name, cwd })
    })
  );
}

export async function deleteProject(id: string): Promise<void> {
  await ensureOk(
    await fetch(withAccessToken(`/api/projects/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: accessTokenHeaders()
    })
  );
}
