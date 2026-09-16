import type {
  BootstrapPayload,
  CreateSessionOptions,
  OrchestratorCatalog,
  OrchestratorConfig,
  OrchestratorStatus,
  TerminalProject,
  TerminalSessionSummary
} from "./types";
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

export async function getOrchestrator(): Promise<OrchestratorStatus> {
  return parseResponse<OrchestratorStatus>(
    await fetch(withAccessToken("/api/orchestrator"), { headers: accessTokenHeaders() })
  );
}

export async function sendOrchestratorMessage(text: string): Promise<OrchestratorStatus> {
  return parseResponse<OrchestratorStatus>(
    await fetch(withAccessToken("/api/orchestrator/messages"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...accessTokenHeaders() },
      body: JSON.stringify({ text })
    })
  );
}

export async function cancelOrchestrator(): Promise<OrchestratorStatus> {
  return parseResponse<OrchestratorStatus>(
    await fetch(withAccessToken("/api/orchestrator/cancel"), { method: "POST", headers: accessTokenHeaders() })
  );
}

export async function clearOrchestrator(): Promise<OrchestratorStatus> {
  return parseResponse<OrchestratorStatus>(
    await fetch(withAccessToken("/api/orchestrator/messages"), { method: "DELETE", headers: accessTokenHeaders() })
  );
}

export interface OrchestratorConfigPatch {
  provider?: OrchestratorConfig["provider"];
  baseUrl?: string;
  model?: string;
  keyEnv?: string;
  /** A string sets a manual key; an empty string or null goes back to the environment variable. */
  apiKey?: string | null;
  reasoning?: OrchestratorConfig["reasoning"];
}

export async function updateOrchestratorConfig(patch: OrchestratorConfigPatch): Promise<OrchestratorConfig> {
  return parseResponse<OrchestratorConfig>(
    await fetch(withAccessToken("/api/orchestrator/config"), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...accessTokenHeaders() },
      body: JSON.stringify(patch)
    })
  );
}

export async function getOrchestratorModels(refresh = false): Promise<OrchestratorCatalog> {
  return parseResponse<OrchestratorCatalog>(
    await fetch(withAccessToken(`/api/orchestrator/models${refresh ? "?refresh=1" : ""}`), {
      headers: accessTokenHeaders()
    })
  );
}

export async function testOrchestratorConnection(): Promise<{ ok: boolean; message: string }> {
  return parseResponse<{ ok: boolean; message: string }>(
    await fetch(withAccessToken("/api/orchestrator/test"), { method: "POST", headers: accessTokenHeaders() })
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
