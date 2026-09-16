import { apiUrl, type ServerEndpoint } from "./endpoint";
import type { OrchestratorStatus } from "../orchestratorTypes";

export async function requestOrchestrator(endpoint: ServerEndpoint, action: "status" | "send" | "cancel", text?: string): Promise<OrchestratorStatus> {
  const path = action === "status" ? "/api/orchestrator" : action === "send" ? "/api/orchestrator/messages" : "/api/orchestrator/cancel";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(apiUrl(endpoint, path), {
      method: action === "status" ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(endpoint.token ? { "x-terminal-web-token": endpoint.token } : {}) },
      ...(action === "send" ? { body: JSON.stringify({ text }) } : {}),
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 501) throw new Error("Connect to the desktop terminal host to use Orchestrator.");
    if (response.status === 409) throw new Error("Orchestrator is already working. Wait for it to finish or tap Stop.");
    if (!response.ok) throw new Error(`Orchestrator request failed (${response.status}).`);
    const value = await response.json() as OrchestratorStatus;
    if (typeof value.seq !== "number" || !["idle", "running", "unconfigured", "unavailable"].includes(value.state)) {
      throw new Error("This host does not support the shared Orchestrator chat yet.");
    }
    return value;
  } finally { clearTimeout(timer); }
}
