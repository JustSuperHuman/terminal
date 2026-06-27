import type { TerminalHostPeer, TerminalProfile, TerminalSessionSummary, ServerInfo } from "./types.js";

interface BootstrapShape {
  sessions?: TerminalSessionSummary[];
  profiles?: TerminalProfile[];
  server?: ServerInfo;
}

function isServerInfo(value: unknown): value is ServerInfo {
  const candidate = value as ServerInfo;
  return (
    Boolean(candidate) &&
    typeof candidate.pid === "number" &&
    typeof candidate.host === "string" &&
    typeof candidate.port === "number" &&
    typeof candidate.startedAt === "string"
  );
}

function isSessionList(value: unknown): value is TerminalSessionSummary[] {
  return Array.isArray(value) && value.every((session) => typeof session?.id === "string" && typeof session?.title === "string");
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      }
    });
    if (!response.ok) {
      return undefined;
    }
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function getScanWidth(): number {
  const parsed = Number(process.env.TERMINAL_WEB_DISCOVERY_PORTS ?? "100");
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 500) : 100;
}

export async function discoverTerminalWebPeers(current: ServerInfo, startPort: number): Promise<TerminalHostPeer[]> {
  const ports = Array.from({ length: getScanWidth() }, (_, index) => startPort + index).filter((port) => port !== current.port);

  const discovered = await Promise.all(
    ports.map(async (port): Promise<TerminalHostPeer | undefined> => {
      const url = `http://127.0.0.1:${port}`;
      const payload = (await fetchJsonWithTimeout(`${url}/api/bootstrap`, 350)) as BootstrapShape | undefined;

      if (!payload || !isServerInfo(payload.server) || !isSessionList(payload.sessions)) {
        return undefined;
      }

      if (payload.server.pid === current.pid) {
        return undefined;
      }

      return {
        id: `${payload.server.pid}:${payload.server.port}`,
        url,
        server: payload.server,
        sessions: payload.sessions,
        profiles: Array.isArray(payload.profiles) ? payload.profiles : [],
        reachable: true
      };
    })
  );

  return discovered
    .filter(Boolean)
    .sort((a, b) => a!.server.port - b!.server.port) as TerminalHostPeer[];
}
