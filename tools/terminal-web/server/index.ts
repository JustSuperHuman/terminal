import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import express, { type Request, type Response } from "express";
import type { McpServer } from "@agentclientprotocol/sdk";
import { WebSocket, WebSocketServer } from "ws";
import { AcpManager } from "./acp-manager.js";
import { AgentLinkRegistry, agentLinkCandidates, terminalAcpAgent } from "./agent-links.js";
import type { AcpAgentId, AcpPromptBlockInput } from "./acp-types.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { searchFiles } from "./file-search.js";
import { discoverHostTerminals } from "./host-discovery.js";
import { BellDetector, NotificationCenter } from "./notifications.js";
import { Orchestrator } from "./orchestrator.js";
import { discoverTerminalWebPeers } from "./peer-discovery.js";
import { PeerProxy } from "./peer-proxy.js";
import { listenOnAvailablePort } from "./ports.js";
import { ProjectStore } from "./projects.js";
import {
  describeInputContext,
  planPromptResponse,
  type SessionPromptResponse
} from "./session-input.js";
import { listSlashCommands } from "./slash-commands.js";
import { TerminalAgentMetadataDetector } from "./terminal-agent-metadata.js";
import { TerminalManager, type SessionInputSnapshot } from "./terminal-manager.js";
import { TerminalPromptMonitor, type TerminalAgentObservationEvent } from "./terminal-prompt-monitor.js";
import { WorkingDirectoryDetector } from "./working-directories.js";
import type {
  BridgeCommandInfo,
  ClientMessage,
  HostTerminalProcess,
  OrchestratorAgent,
  ServerInfo,
  ServerMessage,
  TerminalNotification,
  TerminalProfile,
  TerminalHostPeer,
  TerminalSessionExport,
  TerminalSessionSummary
} from "./types.js";

const startedAt = new Date().toISOString();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const bridgeWss = new WebSocketServer({ noServer: true });
const manager = new TerminalManager();
const acpManager = new AcpManager();
const agentLinks = new AgentLinkRegistry();
const bridgeRegistry = new BridgeRegistry();
const projectStore = new ProjectStore();
const peerProxy = new PeerProxy(() => peerHosts);
const orchestrator = new Orchestrator({
  manager,
  getPort: () => serverInfo.port,
  getToken: () => accessToken
});

let hostProcesses: HostTerminalProcess[] = [];
let peerHosts: TerminalHostPeer[] = [];
let accessToken: string | undefined;
let serverInfo: ServerInfo = {
  pid: process.pid,
  host: "0.0.0.0",
  port: 10001,
  startedAt,
  urls: []
};

interface OutputEvent {
  sessionId: string;
  seq: number;
  data: string;
}

interface PendingOutput {
  seq: number;
  data: string;
}

type HeartbeatWebSocket = WebSocket & { isAlive?: boolean };

interface CreateSessionOptions {
  title?: string;
  profileId?: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  projectId?: string;
  cols?: number;
  rows?: number;
  /** Per-request override of TERMINAL_WEB_CREATE_MODE (the orchestrator uses "managed" for web-only sessions). */
  mode?: "auto" | "desktop" | "managed";
  /** Internal-only environment overrides used for ACP terminal login. */
  env?: Record<string, string>;
}

interface ResolvedSessionCommand {
  profile?: TerminalProfile;
  terminalProfileGuid?: string;
  requestedCwd?: string;
  title: string;
  shell: string;
  args: string[];
  cwd: string;
}

const MAX_BUFFERED_OUTPUT_BYTES = 128 * 1024;
let pendingOutputs = new Map<string, PendingOutput>();
let outputFlushTimer: ReturnType<typeof setTimeout> | undefined;

// Which sessions each client is watching, keyed by subscription slot (the
// main terminal surface and the orchestrator panel each own a slot, so both
// can stream at once; subscribing replaces only the caller's slot). Full
// output bytes are only streamed to clients watching that session; everyone
// else gets a lightweight throttled "activity" ping so unread badges still
// tick. Without this, every session's output was broadcast to every client,
// which saturated slow (mobile) connections as soon as a few sessions were
// busy and starved the active terminal's own stream.
const clientSubscriptions = new WeakMap<WebSocket, Map<string, string>>();

function isClientWatching(client: WebSocket, sessionId: string): boolean {
  const slots = clientSubscriptions.get(client);
  if (!slots) {
    return false;
  }
  for (const watched of slots.values()) {
    if (watched === sessionId) {
      return true;
    }
  }
  return false;
}
const ACTIVITY_PING_INTERVAL_MS = 1000;
const lastActivityPingAt = new Map<string, number>();

// Task-finish signals. Bare BELs and notification OSCs in any session's output
// become session-attributed notify broadcasts (throttled per session so a
// bell-happy program can't flood every client), and everything is recorded so
// reconnecting clients can catch up on what they missed.
const notificationCenter = new NotificationCenter();
const NOTIFY_THROTTLE_MS = 4000;
const lastNotifyAt = new Map<string, number>();
const pendingBellNotifications = new Map<string, ReturnType<typeof setTimeout>>();

function emitNotification(partial: Omit<TerminalNotification, "id" | "at">): void {
  const notification = notificationCenter.record(partial);
  broadcast({ type: "notify", ...notification });
}

function publishTerminalNotification(event: {
  sessionId: string;
  origin: "bell" | "osc";
  title?: string;
  body?: string;
}): void {
  const now = Date.now();
  if (now - (lastNotifyAt.get(event.sessionId) ?? 0) < NOTIFY_THROTTLE_MS) {
    return;
  }
  lastNotifyAt.set(event.sessionId, now);

  const session = allSessions().find((candidate) => candidate.id === event.sessionId);
  emitNotification({
    origin: event.origin,
    sessionId: event.sessionId,
    sessionTitle: session?.title,
    title: event.title ?? session?.title ?? "Terminal",
    body: event.body ?? (event.origin === "bell" ? "Task finished" : undefined),
    sound: "done"
  });
}

const bellDetector = new BellDetector((event) => {
  // A bare BEL often accompanies a question. Give the rendered prompt parser
  // one short settle window to replace the generic "Task finished" alert with
  // the actionable "needs input" alert; explicit OSC notifications stay
  // immediate because they already carry their intended meaning.
  if (event.origin === "osc") {
    publishTerminalNotification(event);
    return;
  }
  const existing = pendingBellNotifications.get(event.sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingBellNotifications.delete(event.sessionId);
    publishTerminalNotification(event);
  }, 300);
  timer.unref?.();
  pendingBellNotifications.set(event.sessionId, timer);
});

const workingDirectoryDetector = new WorkingDirectoryDetector(({ sessionId, cwd }) => {
  if (bridgeRegistry.hasSession(sessionId)) {
    bridgeRegistry.updateCwd(sessionId, cwd);
  } else {
    manager.updateCwd(sessionId, cwd);
  }
});

const terminalAgentMetadataDetector = new TerminalAgentMetadataDetector(({ sessionId, ...event }) => {
  if (bridgeRegistry.hasSession(sessionId)) {
    bridgeRegistry.updateAgentPresence(sessionId, event);
  } else {
    manager.updateAgentPresence(sessionId, event);
  }
});

// A settled render is the only signal a hand-launched agent gives us. The
// managers ignore no-op observations, so this stays quiet until the terminal
// actually enters, leaves, or changes agent state.
function applyAgentObservation({ sessionId, ...observation }: TerminalAgentObservationEvent): void {
  if (bridgeRegistry.hasSession(sessionId)) {
    bridgeRegistry.updateAgentObservation(sessionId, observation);
  } else {
    manager.updateAgentObservation(sessionId, observation);
  }
}

const terminalPromptMonitor = new TerminalPromptMonitor(readInputSnapshot, ({ sessionId, context }) => {
  const pendingBell = pendingBellNotifications.get(sessionId);
  if (pendingBell) clearTimeout(pendingBell);
  pendingBellNotifications.delete(sessionId);
  lastNotifyAt.set(sessionId, Date.now());

  const session = allSessions().find((candidate) => candidate.id === sessionId);
  emitNotification({
    origin: "api",
    sessionId,
    sessionTitle: session?.title,
    title: `${context.agentLabel} needs input`,
    body: `Open ${session?.title ?? "this terminal"} to answer.`,
    sound: "attention"
  });
}, { onObservation: applyAgentObservation });

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const pathname = requestUrl.pathname;
  const target = pathname === "/ws" ? wss : pathname === "/bridge" ? bridgeWss : undefined;

  if (!target) {
    socket.destroy();
    return;
  }

  if (!isAuthorizedSocket(request, requestUrl)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  target.handleUpgrade(request, socket, head, (ws) => {
    target.emit("connection", ws, request);
  });
});

function getArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    return process.argv[index + 1];
  }

  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function getStartPort(): number {
  const raw = getArgValue("--port") ?? process.env.TERMINAL_WEB_PORT ?? "10001";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10001;
}

function getHost(): string {
  return getArgValue("--host") ?? process.env.TERMINAL_WEB_HOST ?? "0.0.0.0";
}

function isAllInterfacesHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function getAccessToken(host: string): string | undefined {
  if (process.env.TERMINAL_WEB_AUTH === "off") {
    return undefined;
  }

  const configured = process.env.TERMINAL_WEB_ACCESS_TOKEN ?? process.env.TERMINAL_WEB_AUTH_TOKEN;
  if (configured) {
    return configured;
  }

  if (!isAllInterfacesHost(host) && isLoopbackHost(host)) {
    return undefined;
  }

  const tokenPath = path.resolve(process.cwd(), ".terminal-web-token");
  try {
    const saved = readFileSync(tokenPath, "utf8").trim();
    if (saved) {
      return saved;
    }
  } catch {
    // Missing or unreadable token files are recovered by generating a new token.
  }

  const generated = randomBytes(24).toString("base64url");
  try {
    writeFileSync(tokenPath, `${generated}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn("Could not persist terminal web access token:", error instanceof Error ? error.message : String(error));
  }
  return generated;
}

function getDiscoveryIntervalMs(): number {
  const raw = process.env.TERMINAL_WEB_DISCOVERY_INTERVAL_MS ?? "15000";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 3000 ? Math.floor(parsed) : 15000;
}

function getOutputFlushMs(): number {
  const raw = process.env.TERMINAL_WEB_OUTPUT_FLUSH_MS ?? "33";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(Math.floor(parsed), 250) : 33;
}

function getWebSocketHeartbeatMs(): number {
  const raw = process.env.TERMINAL_WEB_WS_HEARTBEAT_MS ?? "5000";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 3000 ? Math.floor(parsed) : 5000;
}

function getDesktopCreateTimeoutMs(): number {
  const raw = process.env.TERMINAL_WEB_DESKTOP_CREATE_TIMEOUT_MS ?? "8000";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : 8000;
}

function getSessionCreateMode(): "auto" | "desktop" | "managed" {
  const mode = (process.env.TERMINAL_WEB_CREATE_MODE ?? "auto").toLowerCase();
  return mode === "desktop" || mode === "managed" ? mode : "auto";
}

function installWebSocketHeartbeat(target: WebSocketServer): void {
  target.on("connection", (ws) => {
    const socket = ws as HeartbeatWebSocket;
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
  });

  const timer = setInterval(() => {
    for (const socket of target.clients as Set<HeartbeatWebSocket>) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, getWebSocketHeartbeatMs());
  timer.unref?.();

  target.on("close", () => {
    clearInterval(timer);
  });
}

function urlWithAccessToken(address: string, port: number, tokenRequired: boolean): string {
  const url = new URL(`http://${address}:${port}`);
  if (tokenRequired && accessToken) {
    url.searchParams.set("token", accessToken);
  }
  return url.toString();
}

function getServerAccessUrls(host: string, port: number): ServerInfo["urls"] {
  const urls = new Map<string, ServerInfo["urls"][number]>();
  const add = (label: string, address: string, scope: "local" | "network") => {
    const tokenRequired = Boolean(accessToken && scope === "network");
    const url = urlWithAccessToken(address, port, tokenRequired);
    if (!urls.has(url)) {
      urls.set(url, {
        label,
        address,
        url,
        scope,
        tokenRequired
      });
    }
  };

  const normalizedHost = host.toLowerCase();
  add("Local", normalizedHost === "localhost" ? "localhost" : "127.0.0.1", "local");

  if (normalizedHost !== "0.0.0.0" && normalizedHost !== "::" && normalizedHost !== "localhost" && !normalizedHost.startsWith("127.")) {
    add("Bound host", host, "network");
  }

  if (normalizedHost === "0.0.0.0" || normalizedHost === "::") {
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      for (const detail of addresses ?? []) {
        if (String(detail.family) === "IPv4" && !detail.internal) {
          add(name, detail.address, "network");
        }
      }
    }
  }

  return [...urls.values()];
}

function isLoopbackRemoteAddress(value?: string): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

function hasValidAccessToken(value?: string | null): boolean {
  if (!accessToken) {
    return true;
  }
  if (!value) {
    return false;
  }

  const expected = Buffer.from(accessToken);
  const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isAuthorizedRequest(req: express.Request): boolean {
  if (!accessToken || isLoopbackRemoteAddress(req.socket.remoteAddress)) {
    return true;
  }
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  return hasValidAccessToken(req.get("x-terminal-web-token") ?? queryToken);
}

function isAuthorizedSocket(request: http.IncomingMessage, requestUrl: URL): boolean {
  if (!accessToken || isLoopbackRemoteAddress(request.socket.remoteAddress)) {
    return true;
  }
  return hasValidAccessToken(request.headers["x-terminal-web-token"]?.toString() ?? requestUrl.searchParams.get("token"));
}

function quotePowerShell(value: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/`/g, "``").replace(/"/g, '`"')}"`;
}

function bridgeCommand(title: string, command: string): string {
  const serverUrl = `http://127.0.0.1:${serverInfo.port}`;
  const packageRoot = path.resolve(process.cwd());
  return [
    "npm",
    "--prefix",
    quotePowerShell(packageRoot),
    "run",
    "bridge",
    "--",
    "--server",
    serverUrl,
    "--title",
    quotePowerShell(title),
    "--",
    command
  ].join(" ");
}

function getBridgeCommands(): BridgeCommandInfo {
  const serverUrl = `http://127.0.0.1:${serverInfo.port}`;
  const hasCodex = manager.profiles.some((profile) => profile.id === "codex");
  const hasClaude = manager.profiles.some((profile) => profile.id === "claude");

  return {
    serverUrl,
    shell: bridgeCommand("External Shell", "pwsh -NoLogo"),
    codex: hasCodex ? bridgeCommand("Codex", "codex") : undefined,
    claude: hasClaude ? bridgeCommand("Claude", "claude") : undefined
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeCreateSessionOptions(value: any): CreateSessionOptions {
  const options: CreateSessionOptions = {};
  options.title = optionalString(value?.title);
  options.profileId = optionalString(value?.profileId);
  options.shell = optionalString(value?.shell);
  options.cwd = optionalString(value?.cwd);
  options.projectId = optionalString(value?.projectId);

  const mode = optionalString(value?.mode);
  if (mode === "auto" || mode === "desktop" || mode === "managed") {
    options.mode = mode;
  }

  if (Array.isArray(value?.args)) {
    options.args = value.args.map((arg: unknown) => String(arg));
  }

  const cols = Number(value?.cols);
  const rows = Number(value?.rows);
  if (Number.isFinite(cols)) {
    options.cols = Math.floor(cols);
  }
  if (Number.isFinite(rows)) {
    options.rows = Math.floor(rows);
  }

  return options;
}

function resolveCreateCommand(options: CreateSessionOptions): ResolvedSessionCommand {
  const requestedProfile = options.profileId
    ? manager.profiles.find((candidate) => candidate.id === options.profileId)
    : undefined;
  const fallbackProfile = requestedProfile ?? manager.defaultProfile;
  const explicitShell = options.shell;
  const shell = explicitShell ?? fallbackProfile?.shell;

  if (!shell) {
    throw new Error("No terminal shell profile is available.");
  }

  return {
    profile: fallbackProfile,
    terminalProfileGuid: explicitShell ? undefined : fallbackProfile?.terminalProfileGuid,
    requestedCwd: options.cwd,
    title: options.title ?? (explicitShell ? path.basename(shell) : fallbackProfile?.label ?? "Terminal"),
    shell,
    args: options.args ?? (explicitShell ? [] : fallbackProfile?.args ?? []),
    cwd: options.cwd ?? process.cwd()
  };
}

function resolveWindowsTerminalLauncher(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    // The dev package's app execution alias.
    const wtd = path.join(localAppData, "Microsoft", "WindowsApps", "wtd.exe");
    if (existsSync(wtd)) {
      return wtd;
    }
    // The per-user shim installed by `bun run update` (forwards to wtd.exe).
    const shim = path.join(localAppData, "Programs", "WindowsTerminalDevShim", "wt.exe");
    if (existsSync(shim)) {
      return shim;
    }
  }
  return "wt.exe";
}

function buildWindowsTerminalNewTabArgs(command: ResolvedSessionCommand): string[] {
  // Run the requested shell directly: the dev Windows Terminal mirrors every
  // ConPTY session into this server in-process, so the old Node bridge
  // wrapper is unnecessary (and used to double-register every tab).
  // "-w 0" targets the existing window (new tab) and only creates a new
  // window when none is running.
  if (command.terminalProfileGuid) {
    const args = ["-w", "0", "new-tab", "--profile", command.terminalProfileGuid];
    if (command.requestedCwd) {
      args.push("--startingDirectory", command.requestedCwd);
    }
    return args;
  }

  return [
    "-w",
    "0",
    "new-tab",
    "--title",
    command.title,
    "--startingDirectory",
    command.cwd,
    "--",
    command.shell,
    ...command.args
  ];
}

function hasTerminalWebRootNear(executablePath: string): boolean {
  let cursor = path.dirname(executablePath);
  for (let depth = 0; depth < 14 && cursor; depth += 1) {
    if (existsSync(path.join(cursor, "tools", "terminal-web", "package.json"))) {
      return true;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return false;
}

function windowsTerminalHostRank(host: HostTerminalProcess): number {
  const executable = host.executablePath?.toLowerCase() ?? "";
  let rank = 0;

  if (host.executablePath && hasTerminalWebRootNear(host.executablePath)) {
    rank -= 100;
  }
  if (executable.includes("\\terminal-portable-")) {
    rank -= 50;
  }
  if (executable.includes("\\src\\cascadia\\")) {
    rank -= 25;
  }
  if (executable.includes("\\windowsapps\\")) {
    rank += 25;
  }

  return rank;
}

function getPreferredWindowsTerminalHost(): HostTerminalProcess | undefined {
  return hostProcesses
    .filter((host) => host.name.toLowerCase() === "windowsterminal.exe" && host.executablePath)
    .sort((a, b) => {
      const rank = windowsTerminalHostRank(a) - windowsTerminalHostRank(b);
      return rank !== 0 ? rank : a.pid - b.pid;
    })[0];
}

function waitForNextBridgeSession(beforeIds: Set<string>, timeoutMs: number) {
  let cleanup = () => undefined;
  const promise = new Promise<TerminalSessionSummary>((resolve, reject) => {
    const onSession = (session: TerminalSessionSummary) => {
      if (session.source === "bridged" && !beforeIds.has(session.id)) {
        cleanup();
        resolve(session);
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for the desktop tab to register with terminal-web after ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref?.();

    cleanup = () => {
      clearTimeout(timer);
      bridgeRegistry.off("session", onSession);
    };

    bridgeRegistry.on("session", onSession);
    for (const session of bridgeRegistry.listSessions()) {
      onSession(session);
    }
  });

  return { promise, cancel: cleanup };
}

async function createDesktopTerminalSession(options: CreateSessionOptions): Promise<TerminalSessionSummary | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }

  // Launch through the dev package's execution alias: packaged Windows
  // Terminal builds cannot be started via their exe path (package identity),
  // and "-w 0" already routes to the existing window when one is running —
  // otherwise a fresh instance (new window) is started. The alias is resolved
  // explicitly because a plain "wt.exe" PATH lookup can land on the Store
  // terminal (which doesn't mirror into this server) in stale environments.
  const executablePath = resolveWindowsTerminalLauncher();

  const command = resolveCreateCommand(options);
  const beforeIds = new Set(bridgeRegistry.listSessions().map((session) => session.id));
  const waiter = waitForNextBridgeSession(beforeIds, getDesktopCreateTimeoutMs());
  const args = buildWindowsTerminalNewTabArgs(command);

  try {
    const child = spawn(executablePath, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        TERMINAL_WEB_ROOT: process.cwd(),
        TERMINAL_WEB_SERVER: `http://127.0.0.1:${serverInfo.port}`
      }
    });

    child.unref();
    return await Promise.race([
      waiter.promise,
      new Promise<TerminalSessionSummary>((_resolve, reject) => {
        child.once("error", reject);
      })
    ]);
  } catch (error) {
    waiter.cancel();
    throw new Error(
      `Could not open a bridged Windows Terminal tab via ${executablePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function createSession(options: CreateSessionOptions): Promise<TerminalSessionSummary> {
  if (options.projectId && !options.cwd) {
    options.cwd = projectStore.get(options.projectId)?.cwd;
  }

  const mode = options.mode ?? getSessionCreateMode();
  if (mode !== "managed") {
    try {
      const session = await createDesktopTerminalSession(options);
      if (session) {
        if (options.projectId) {
          // Persist the project association on the registered bridged session
          // so the sidebar/mobile grouping sees it, not just this response.
          return bridgeRegistry.assignProject(session.id, options.projectId) ?? { ...session, projectId: options.projectId };
        }
        return session;
      }
    } catch (error) {
      if (mode === "desktop") {
        throw error;
      }
      console.warn(
        "Desktop tab creation failed; falling back to a managed session:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return manager.createSession(options);
}

// ACP terminal authentication is intentionally a second, visible terminal
// process. The adapter's stdio is reserved for JSON-RPC and must never be
// reused for an interactive login. Keeping login in TerminalManager also makes
// it reachable from both the desktop surface and the phone's session list.
acpManager.setTerminalAuthHandler(async (launch) => {
  let authSessionId: string | undefined;
  const completed = new Promise<void>((resolve, reject) => {
    const onExit = (event: { sessionId: string; exitCode?: number }) => {
      if (!authSessionId || event.sessionId !== authSessionId) return;
      manager.off("exit", onExit);
      if (event.exitCode === 0) resolve();
      else reject(new Error(`${launch.title} exited before authentication completed.`));
    };
    manager.on("exit", onExit);
  });
  const session = manager.createSession({
    title: launch.title,
    shell: launch.shell,
    args: launch.args,
    env: launch.env,
    detectAgent: false,
    cwd: process.cwd(),
    cols: 120,
    rows: 34
  });
  authSessionId = session.id;
  emitNotification({
    origin: "api",
    sessionId: session.id,
    sessionTitle: session.title,
    title: launch.title,
    body: "Complete sign-in in this terminal, then return to Agent workspace.",
    sound: "attention"
  });
  await completed;
});

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(message: ServerMessage): void {
  const body = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(body);
    }
  }
}

function flushOutputs(): void {
  if (outputFlushTimer) {
    clearTimeout(outputFlushTimer);
    outputFlushTimer = undefined;
  }

  const outputs = pendingOutputs;
  pendingOutputs = new Map();

  const now = Date.now();
  for (const [sessionId, output] of outputs) {
    const outputBody = JSON.stringify({ type: "output", sessionId, seq: output.seq, data: output.data });
    const pingDue = now - (lastActivityPingAt.get(sessionId) ?? 0) >= ACTIVITY_PING_INTERVAL_MS;
    const activityBody = JSON.stringify({ type: "activity", sessionId, seq: output.seq });
    let pinged = false;
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (isClientWatching(client, sessionId)) {
        client.send(outputBody);
      } else if (pingDue) {
        client.send(activityBody);
        pinged = true;
      }
    }
    if (pinged) {
      lastActivityPingAt.set(sessionId, now);
    }
  }
}

function queueOutput(event: OutputEvent): void {
  const existing = pendingOutputs.get(event.sessionId);
  if (existing) {
    existing.seq = event.seq;
    existing.data += event.data;
  } else {
    pendingOutputs.set(event.sessionId, {
      seq: event.seq,
      data: event.data
    });
  }

  const bufferedBytes = [...pendingOutputs.values()].reduce((total, output) => total + Buffer.byteLength(output.data, "utf8"), 0);
  if (bufferedBytes >= MAX_BUFFERED_OUTPUT_BYTES) {
    flushOutputs();
    return;
  }

  if (!outputFlushTimer) {
    outputFlushTimer = setTimeout(flushOutputs, getOutputFlushMs());
    outputFlushTimer.unref?.();
  }
}

function allSessions() {
  return agentLinks.decorate([...manager.listSessions(), ...bridgeRegistry.listSessions()]);
}

function decorateSession(session: TerminalSessionSummary): TerminalSessionSummary {
  return agentLinks.decorate([session])[0]!;
}

let reconcilingProjects = false;

// Saved projects remain useful as launch shortcuts, but the visible project
// strip contains only directories currently used by a running session. Keep
// one ephemeral project for every other active directory and make each
// session's project assignment follow its live cwd.
function reconcileProjects(): void {
  if (reconcilingProjects) {
    return;
  }

  reconcilingProjects = true;
  try {
    const sessions = allSessions();
    // The orchestrator session lives in its own panel; keep it out of the
    // project strip so it doesn't conjure an ephemeral project for its cwd.
    const running = sessions.filter((session) => session.status === "running" && session.kind !== "orchestrator");
    const projectsChanged = projectStore.syncActiveDirectories(running.map((session) => session.cwd));

    for (const session of running) {
      const projectId = projectStore.projectIdForCwd(session.cwd);
      if (bridgeRegistry.hasSession(session.id)) {
        bridgeRegistry.assignProject(session.id, projectId);
      } else {
        manager.assignProject(session.id, projectId);
      }
    }

    if (projectsChanged) {
      broadcast({ type: "projects", projects: projectStore.list() });
    }
  } finally {
    reconcilingProjects = false;
  }
}

function startProjectRefreshLoop(): void {
  reconcileProjects();
  const timer = setInterval(reconcileProjects, 5000);
  timer.unref?.();
}

function getSessionExport(id: string): TerminalSessionExport | undefined {
  if (manager.getSession(id)) {
    return manager.getExport(id);
  }
  if (bridgeRegistry.hasSession(id)) {
    return bridgeRegistry.getExport(id);
  }
  return undefined;
}

function safeExportName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "terminal";
}

// Uploaded images land in the OS temp dir (a path without spaces, which every
// terminal AI agent accepts verbatim) and are pruned after a day.
const ATTACHMENTS_DIR = path.join(os.tmpdir(), "terminal-web-attachments");
const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif"
};

async function pruneAttachments(): Promise<void> {
  const cutoff = Date.now() - ATTACHMENT_TTL_MS;
  let entries: string[];
  try {
    entries = await readdir(ATTACHMENTS_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(ATTACHMENTS_DIR, entry);
    try {
      const info = await stat(file);
      if (info.isFile() && info.mtimeMs < cutoff) {
        await unlink(file);
      }
    } catch {
      // A file disappearing mid-prune is fine.
    }
  }
}

function writeSessionInput(sessionId: string, data: string): void {
  if (bridgeRegistry.hasSession(sessionId)) {
    bridgeRegistry.write(sessionId, data);
  } else {
    manager.write(sessionId, data);
  }
}

// How much rendered screen the input heuristics read. The agent fingerprints
// and any open dialog live in the last couple of screens.
const INPUT_CONTEXT_TAIL_LINES = 80;

function readInputSnapshot(sessionId: string): SessionInputSnapshot | undefined {
  if (manager.getSession(sessionId)) {
    return manager.getInputSnapshot(sessionId, INPUT_CONTEXT_TAIL_LINES);
  }
  if (bridgeRegistry.hasSession(sessionId)) {
    return bridgeRegistry.getInputSnapshot(sessionId, INPUT_CONTEXT_TAIL_LINES);
  }
  return undefined;
}

// Composed text is delivered in paced chunks: a PTY (and, for bridged
// sessions, the WebSocket hop to the desktop terminal) drops or reorders very
// large single writes, and a TUI that re-renders per keystroke needs room to
// keep up. Sizes are conservative — a long prompt still lands in well under a
// second.
const PASTE_CHUNK_CHARS = 512;
const PASTE_CHUNK_DELAY_MS = 6;
// Enter has to arrive after the paste has been processed, or agents that
// buffer the paste (Claude Code collapses it into a "[Pasted text]" token)
// submit an empty prompt.
const SUBMIT_SETTLE_MS = 80;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writePaced(sessionId: string, data: string): Promise<void> {
  for (let offset = 0; offset < data.length; ) {
    let end = Math.min(data.length, offset + PASTE_CHUNK_CHARS);
    // Never split a surrogate pair across writes — half a pair is a broken
    // character on the other side.
    const boundary = data.charCodeAt(end - 1);
    if (end < data.length && boundary >= 0xd800 && boundary <= 0xdbff) {
      end += 1;
    }
    writeSessionInput(sessionId, data.slice(offset, end));
    offset = end;
    if (offset < data.length) {
      await sleep(PASTE_CHUNK_DELAY_MS);
    }
  }
}

interface ComposeResult {
  method: "paste" | "raw" | "none";
  submitted: boolean;
}

interface PromptResponseResult {
  accepted: true;
  promptId: string;
  action: SessionPromptResponse["action"];
}

// A consuming answer can sit on screen for a few render frames after its key
// lands. Suppress an identical second tap during that window so it cannot
// become input to the next question. Multi-select toggles use a shorter guard
// because quick taps on different rows are intentional.
const recentPromptResponses = new Map<string, number>();

function parsePromptResponse(value: unknown): SessionPromptResponse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  if (body.action === "cancel" || body.action === "open-notes") {
    return { action: body.action };
  }
  if ((body.action === "select" || body.action === "toggle") && typeof body.optionId === "string") {
    return { action: body.action, optionId: body.optionId };
  }
  if (body.action === "submit") {
    const optionIds = Array.isArray(body.optionIds)
      ? body.optionIds.filter((item): item is string => typeof item === "string").slice(0, 99)
      : undefined;
    return { action: "submit", optionIds };
  }
  if (body.action === "text" && typeof body.text === "string" && body.text.length <= 100_000) {
    return { action: "text", text: body.text };
  }
  return undefined;
}

async function deliverPromptResponse(
  sessionId: string,
  promptId: string,
  response: SessionPromptResponse
): Promise<PromptResponseResult> {
  // This second read is the safety boundary: never trust a prompt cached by a
  // phone, because the agent may have advanced while the tap was in flight.
  const snapshot = readInputSnapshot(sessionId);
  if (!snapshot) throw new Error("Unknown terminal session.");
  if (snapshot.session.status !== "running") throw new Error("Terminal session has exited.");

  const context = describeInputContext(snapshot.session, snapshot.text, snapshot.modes);
  if (!context.prompt || context.prompt.id !== promptId) {
    const stale = new Error("That question is no longer active.");
    stale.name = "StalePromptError";
    throw stale;
  }

  const plan = planPromptResponse(context.prompt, response, snapshot.modes, context.agent);
  const discriminator = "optionId" in response ? response.optionId : response.action;
  // All consuming actions share one prompt-level lock. Two phones choosing
  // different rows in the same render window must not both land before the
  // TUI redraws; non-consuming multi-select toggles remain independently keyed.
  const serializedNavigation = response.action === "toggle" || response.action === "open-notes";
  const guardKey = plan.consumesPrompt
    ? `${sessionId}:${promptId}:consume`
    : serializedNavigation
      ? `${sessionId}:${promptId}:navigation`
      : `${sessionId}:${promptId}:${response.action}:${discriminator}`;
  const now = Date.now();
  const guardMs = plan.consumesPrompt ? 900 : response.action === "toggle" ? 220 : 600;
  if (now - (recentPromptResponses.get(guardKey) ?? 0) < guardMs) {
    const duplicate = new Error("That response is already being handled.");
    duplicate.name = "DuplicatePromptResponseError";
    throw duplicate;
  }
  recentPromptResponses.set(guardKey, now);

  // Opportunistic cleanup keeps the map bounded without another timer.
  if (recentPromptResponses.size > 500) {
    const cutoff = now - 10_000;
    for (const [key, at] of recentPromptResponses) {
      if (at < cutoff) recentPromptResponses.delete(key);
    }
  }

  try {
    if (plan.method === "compose") {
      await deliverComposedInput(sessionId, plan.text, plan.submit, "auto");
    } else {
      writeSessionInput(sessionId, plan.data);
    }
  } catch (error) {
    recentPromptResponses.delete(guardKey);
    const delivery = new Error(error instanceof Error ? error.message : String(error));
    delivery.name = "PromptDeliveryError";
    throw delivery;
  }
  return { accepted: true, promptId, action: response.action };
}

/**
 * Put a composed message into a session the way a real paste would: wrapped in
 * bracketed-paste markers when the running program asked for them (so multi-
 * line prompts stay one prompt instead of executing line by line), plain bytes
 * when it did not, and Enter only once the text has settled.
 */
async function deliverComposedInput(
  sessionId: string,
  text: string,
  submit: boolean,
  mode: "auto" | "paste" | "raw"
): Promise<ComposeResult> {
  const snapshot = readInputSnapshot(sessionId);
  const context = snapshot ? describeInputContext(snapshot.session, snapshot.text, snapshot.modes) : undefined;
  const normalized = text.replace(/\r\n?/g, "\n");
  const usePaste = mode === "paste" || (mode === "auto" && (context?.pasteSafe ?? false));

  let method: ComposeResult["method"] = "none";
  if (normalized.length > 0) {
    if (usePaste) {
      await writePaced(sessionId, `\x1b[200~${normalized}\x1b[201~`);
      method = "paste";
    } else {
      // Without bracketed paste a newline is just Enter, which is what typing
      // the same text by hand would do.
      await writePaced(sessionId, normalized.replace(/\n/g, "\r"));
      method = "raw";
    }
  }

  if (submit) {
    if (method !== "none") {
      await sleep(SUBMIT_SETTLE_MS);
    }
    writeSessionInput(sessionId, "\r");
  }

  return { method, submitted: submit };
}

function parseMessage(raw: WebSocket.RawData): ClientMessage | undefined {
  try {
    const value = JSON.parse(raw.toString());
    if (typeof value?.type === "string") {
      return value as ClientMessage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function safeAction(ws: WebSocket, action: () => void | Promise<void>): void {
  Promise.resolve()
    .then(action)
    .catch((error) => {
      send(ws, {
        type: "error",
        message: "Terminal host action failed.",
        detail: error instanceof Error ? error.message : String(error)
      });
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireAcpAgent(value: unknown): AcpAgentId {
  if (value === "claude" || value === "codex") return value;
  throw new Error('ACP agent must be "claude" or "codex".');
}

function requireAcpString(value: unknown, label: string, maxLength = 32_768): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  if (value.length > maxLength) throw new Error(`${label} is too long.`);
  return value;
}

function optionalAcpString(value: unknown, label: string, maxLength = 32_768): string | undefined {
  if (value == null || value === "") return undefined;
  return requireAcpString(value, label, maxLength);
}

function acpStringArray(value: unknown, label: string, limit = 16): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > limit) {
    throw new Error(`${label} must contain at most ${limit} paths.`);
  }
  return value.map((item) => requireAcpString(item, `${label} entry`));
}

function acpMcpServers(value: unknown): McpServer[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 32 || !value.every(isRecord)) {
    throw new Error("mcpServers must be a list of at most 32 ACP MCP server definitions.");
  }
  // The SDK validates the selected stdio/HTTP/SSE/ACP union before it reaches
  // an adapter. Do not log this value: MCP definitions can include headers or
  // environment values that must remain on the authenticated desktop bridge.
  return value as McpServer[];
}

function parseAcpPromptBlocks(value: unknown): AcpPromptBlockInput[] {
  const body = isRecord(value) ? value : {};
  const raw = body.content == null ? [] : body.content;
  if (!Array.isArray(raw)) throw new Error("Prompt content must be a list.");
  const blocks: AcpPromptBlockInput[] = [];
  if (typeof body.text === "string" && body.text.length > 0) {
    blocks.push({ type: "text", text: body.text });
  }
  for (const [index, candidate] of raw.entries()) {
    if (!isRecord(candidate) || typeof candidate.type !== "string") {
      throw new Error(`Prompt block ${index + 1} is invalid.`);
    }
    switch (candidate.type) {
      case "text":
        blocks.push({ type: "text", text: requireAcpString(candidate.text, "Prompt text", 320_000) });
        break;
      case "image":
        blocks.push({
          type: "image",
          mimeType: requireAcpString(candidate.mimeType, "Image MIME type", 160),
          data: requireAcpString(candidate.data, "Image data", 17_000_000),
          ...(optionalAcpString(candidate.uri, "Image URI", 8_192) ? { uri: optionalAcpString(candidate.uri, "Image URI", 8_192) } : {})
        });
        break;
      case "audio":
        blocks.push({
          type: "audio",
          mimeType: requireAcpString(candidate.mimeType, "Audio MIME type", 160),
          data: requireAcpString(candidate.data, "Audio data", 17_000_000)
        });
        break;
      case "resource_link":
        blocks.push({
          type: "resource_link",
          uri: requireAcpString(candidate.uri, "Resource URI", 8_192),
          name: requireAcpString(candidate.name, "Resource name", 1_024),
          ...(optionalAcpString(candidate.title, "Resource title", 2_048) ? { title: optionalAcpString(candidate.title, "Resource title", 2_048) } : {}),
          ...(optionalAcpString(candidate.description, "Resource description", 8_192) ? { description: optionalAcpString(candidate.description, "Resource description", 8_192) } : {}),
          ...(optionalAcpString(candidate.mimeType, "Resource MIME type", 160) ? { mimeType: optionalAcpString(candidate.mimeType, "Resource MIME type", 160) } : {})
        });
        break;
      case "resource":
        blocks.push({
          type: "resource",
          uri: requireAcpString(candidate.uri, "Resource URI", 8_192),
          text: typeof candidate.text === "string" ? candidate.text : requireAcpString(candidate.text, "Resource text", 320_000),
          ...(optionalAcpString(candidate.mimeType, "Resource MIME type", 160) ? { mimeType: optionalAcpString(candidate.mimeType, "Resource MIME type", 160) } : {})
        });
        break;
      default:
        throw new Error(`Prompt block type “${candidate.type}” is not supported.`);
    }
  }
  return blocks;
}

function publicAcpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|key|secret|code)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 600);
}

function acpErrorStatus(message: string): number {
  if (/unknown ACP (?:agent|session|terminal)/i.test(message)) return 404;
  if (/not installed|ACP is unavailable|adapter (?:exited|stopped)/i.test(message)) return 503;
  if (/already working|no longer active|does not (?:support|advertise|accept)|unavailable value/i.test(message)) return 409;
  return 400;
}

function acpRoute(handler: (req: Request, res: Response) => void | Promise<void>) {
  return (req: Request, res: Response): void => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (res.headersSent) return;
      const message = publicAcpError(error);
      res.status(acpErrorStatus(message)).json({ message });
    });
  };
}

async function refreshHostProcesses(): Promise<void> {
  hostProcesses = await discoverHostTerminals();
  peerHosts = await discoverTerminalWebPeers(serverInfo, getStartPort());
  broadcast({ type: "host", hostProcesses, peerHosts });
}

// Agent state has to be right for a terminal that is simply sitting there —
// the phone's session list is read far more often than these terminals print.
const AGENT_SWEEP_MS = 4_000;

function startAgentSweepLoop(): void {
  const timer = setInterval(() => {
    terminalPromptMonitor.sweep(
      allSessions()
        .filter((session) => session.status === "running" && !session.kind)
        .map((session) => session.id)
    );
  }, AGENT_SWEEP_MS);
  timer.unref?.();
}

function startHostRefreshLoop(): void {
  const timer = setInterval(() => {
    refreshHostProcesses().catch((error) => {
      console.warn("Host refresh failed:", error instanceof Error ? error.message : String(error));
    });
  }, getDiscoveryIntervalMs());
  timer.unref?.();
}

manager.on("output", (event) => {
  workingDirectoryDetector.feed(event.sessionId, event.data);
  terminalAgentMetadataDetector.feed(event.sessionId, event.data);
  bellDetector.feed(event.sessionId, event.data);
  terminalPromptMonitor.schedule(event.sessionId);
  queueOutput(event);
});

manager.on("session", (session) => {
  reconcileProjects();
  terminalPromptMonitor.schedule(session.id);
  broadcast({ type: "session", session: decorateSession(manager.getSession(session.id) ?? session) });
});

manager.on("sessions", () => {
  reconcileProjects();
  broadcast({ type: "sessions", sessions: allSessions() });
});

manager.on("profiles", (profiles: TerminalProfile[]) => {
  broadcast({ type: "profiles", profiles });
});

manager.on("exit", (event) => {
  flushOutputs();
  lastActivityPingAt.delete(event.sessionId);
  bellDetector.dispose(event.sessionId);
  workingDirectoryDetector.dispose(event.sessionId);
  terminalAgentMetadataDetector.dispose(event.sessionId);
  terminalPromptMonitor.dispose(event.sessionId);
  const pendingBell = pendingBellNotifications.get(event.sessionId);
  if (pendingBell) clearTimeout(pendingBell);
  pendingBellNotifications.delete(event.sessionId);
  lastNotifyAt.delete(event.sessionId);
  broadcast({
    type: "exit",
    sessionId: event.sessionId,
    exitCode: event.exitCode,
    signal: event.signal,
    session: event.session
  });
});

bridgeRegistry.on("output", (event) => {
  workingDirectoryDetector.feed(event.sessionId, event.data);
  terminalAgentMetadataDetector.feed(event.sessionId, event.data);
  // Replayed output rebuilds a fresh server's screen and prompt state, but old
  // BEL/OSC notification bytes must not ring the phone again after a restart.
  if (!event.replay) bellDetector.feed(event.sessionId, event.data);
  terminalPromptMonitor.schedule(event.sessionId);
  queueOutput(event);
});

bridgeRegistry.on("session", (session) => {
  reconcileProjects();
  terminalPromptMonitor.schedule(session.id);
  const current = bridgeRegistry.listSessions().find((candidate) => candidate.id === session.id);
  broadcast({ type: "session", session: decorateSession(current ?? session) });
});

bridgeRegistry.on("sessions", () => {
  reconcileProjects();
  broadcast({ type: "sessions", sessions: allSessions() });
});

bridgeRegistry.on("exit", (event) => {
  flushOutputs();
  lastActivityPingAt.delete(event.sessionId);
  bellDetector.dispose(event.sessionId);
  workingDirectoryDetector.dispose(event.sessionId);
  terminalAgentMetadataDetector.dispose(event.sessionId);
  terminalPromptMonitor.dispose(event.sessionId);
  const pendingBell = pendingBellNotifications.get(event.sessionId);
  if (pendingBell) clearTimeout(pendingBell);
  pendingBellNotifications.delete(event.sessionId);
  lastNotifyAt.delete(event.sessionId);
  broadcast({
    type: "exit",
    sessionId: event.sessionId,
    exitCode: event.exitCode,
    signal: event.signal,
    session: event.session
  });
});

orchestrator.on("status", (status) => {
  broadcast({ type: "orchestrator", orchestrator: status });
});

acpManager.on("state", (acp) => {
  broadcast({ type: "acp_state", acp });
});

acpManager.on("session", (event) => {
  broadcast({ type: "acp_session", ...event });
});

acpManager.on("session_removed", (event) => {
  broadcast({ type: "acp_session_removed", ...event });
});

installWebSocketHeartbeat(wss);
installWebSocketHeartbeat(bridgeWss);

app.use("/api", (req, res, next) => {
  if (isAuthorizedRequest(req)) {
    next();
    return;
  }
  res.status(401).json({ message: "Terminal web access token is required." });
});

// Authenticate before accepting the larger base64 prompt body. Other API
// routes keep their existing small-body ceiling.
app.use("/api/acp", express.json({ limit: "18mb" }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/bootstrap", (_req, res) => {
  res.json({
    sessions: allSessions(),
    profiles: manager.profiles,
    hostProcesses,
    peerHosts,
    projects: projectStore.list(),
    server: serverInfo,
    bridgeCommands: getBridgeCommands(),
    orchestrator: orchestrator.status(),
    acp: acpManager.state()
  });
});

app.get("/api/acp", (_req, res) => {
  res.json(acpManager.state());
});

app.post("/api/acp/agents/:agent/start", acpRoute(async (req, res) => {
  const agent = await acpManager.startAgent(requireAcpAgent(req.params.agent));
  res.json({ agent, acp: acpManager.state() });
}));

app.post("/api/acp/agents/:agent/stop", acpRoute(async (req, res) => {
  const agent = await acpManager.stopAgent(requireAcpAgent(req.params.agent));
  res.json({ agent, acp: acpManager.state() });
}));

app.post("/api/acp/agents/:agent/refresh", acpRoute(async (req, res) => {
  const agent = await acpManager.refreshSessions(requireAcpAgent(req.params.agent));
  res.json({ agent, acp: acpManager.state() });
}));

app.post("/api/acp/agents/:agent/authenticate", acpRoute(async (req, res) => {
  const methodId = requireAcpString(req.body?.methodId, "Authentication method", 512);
  const agent = await acpManager.authenticate(requireAcpAgent(req.params.agent), methodId);
  res.json({ agent, acp: acpManager.state() });
}));

app.post("/api/acp/agents/:agent/logout", acpRoute(async (req, res) => {
  const agent = await acpManager.logout(requireAcpAgent(req.params.agent));
  res.json({ agent, acp: acpManager.state() });
}));

app.post("/api/acp/sessions", acpRoute(async (req, res) => {
  const session = await acpManager.createSession({
    agent: requireAcpAgent(req.body?.agent),
    cwd: requireAcpString(req.body?.cwd, "Working directory"),
    additionalDirectories: acpStringArray(req.body?.additionalDirectories, "Additional directories"),
    mcpServers: acpMcpServers(req.body?.mcpServers)
  });
  res.status(201).json({ session, acp: acpManager.state() });
}));

app.post("/api/acp/sessions/load", acpRoute(async (req, res) => {
  const mode = req.body?.mode == null ? "load" : requireAcpString(req.body.mode, "Load mode", 16);
  if (mode !== "load" && mode !== "resume") throw new Error('Load mode must be "load" or "resume".');
  const session = await acpManager.loadSession({
    agent: requireAcpAgent(req.body?.agent),
    sessionId: requireAcpString(req.body?.sessionId, "Session id", 8_192),
    cwd: requireAcpString(req.body?.cwd, "Working directory"),
    mode,
    additionalDirectories: acpStringArray(req.body?.additionalDirectories, "Additional directories"),
    mcpServers: acpMcpServers(req.body?.mcpServers)
  });
  res.json({ session, acp: acpManager.state() });
}));

app.get("/api/acp/sessions/:id", acpRoute((req, res) => {
  const session = acpManager.session(requireAcpString(req.params.id, "Session id", 12_000));
  if (!session) throw new Error("Unknown ACP session.");
  res.json(session);
}));

app.post("/api/acp/sessions/:id/fork", acpRoute(async (req, res) => {
  const session = await acpManager.forkSession(
    requireAcpString(req.params.id, "Session id", 12_000),
    optionalAcpString(req.body?.cwd, "Working directory")
  );
  res.status(201).json({ session, acp: acpManager.state() });
}));

app.post("/api/acp/sessions/:id/prompt", acpRoute(async (req, res) => {
  const session = await acpManager.promptSession(
    requireAcpString(req.params.id, "Session id", 12_000),
    parseAcpPromptBlocks(req.body),
    { reportFileChanges: req.body?.reportFileChanges === true }
  );
  res.status(202).json({ session, acp: acpManager.state() });
}));

app.post("/api/acp/sessions/:id/cancel", acpRoute(async (req, res) => {
  const session = await acpManager.cancelSession(requireAcpString(req.params.id, "Session id", 12_000));
  res.status(202).json({ session, acp: acpManager.state() });
}));

app.patch("/api/acp/sessions/:id/mode", acpRoute(async (req, res) => {
  const session = await acpManager.setMode(
    requireAcpString(req.params.id, "Session id", 12_000),
    requireAcpString(req.body?.modeId, "Mode", 512),
    req.body?.confirmDangerous === true
  );
  res.json({ session, acp: acpManager.state() });
}));

app.patch("/api/acp/sessions/:id/config/:configId", acpRoute(async (req, res) => {
  const value = req.body?.value;
  if (typeof value !== "string" && typeof value !== "boolean") {
    throw new Error("Configuration value must be text or a boolean.");
  }
  const session = await acpManager.setConfig(
    requireAcpString(req.params.id, "Session id", 12_000),
    requireAcpString(req.params.configId, "Configuration id", 1_024),
    value,
    req.body?.confirmDangerous === true
  );
  res.json({ session, acp: acpManager.state() });
}));

app.post("/api/acp/sessions/:id/goal", acpRoute(async (req, res) => {
  const session = await acpManager.controlGoal(
    requireAcpString(req.params.id, "Session id", 12_000),
    requireAcpString(req.body?.action, "Goal action", 64),
    optionalAcpString(req.body?.objective, "Goal objective", 32_768)
  );
  res.json({ session, acp: acpManager.state() });
}));

app.post("/api/acp/sessions/:id/close", acpRoute(async (req, res) => {
  await acpManager.closeSession(requireAcpString(req.params.id, "Session id", 12_000), false);
  res.status(204).end();
}));

app.delete("/api/acp/sessions/:id", acpRoute(async (req, res) => {
  const deleteRemote = req.query.deleteRemote === "1" || req.query.deleteRemote === "true";
  await acpManager.closeSession(requireAcpString(req.params.id, "Session id", 12_000), deleteRemote);
  res.status(204).end();
}));

app.post("/api/acp/requests/:id/respond", acpRoute((req, res) => {
  const content = req.body?.content;
  if (content != null && !isRecord(content)) throw new Error("Elicitation content must be an object.");
  acpManager.respond(requireAcpString(req.params.id, "Request id", 1_024), {
    action: optionalAcpString(req.body?.action, "Response action", 64),
    optionId: optionalAcpString(req.body?.optionId, "Permission option", 1_024),
    ...(content ? { content } : {})
  });
  res.status(202).json({ acp: acpManager.state() });
}));

app.get("/api/sessions", (_req, res) => {
  res.json(allSessions());
});

// Rendered-screen plain text for machine consumers (the orchestrator's
// read_session tool): the current screen plus recent scrollback, already
// resolved through the headless terminal so TUI redraws come out clean.
app.get("/api/sessions/:id/text", (req, res) => {
  const tail = Number(req.query.tail);
  const lines = Number.isFinite(tail) ? Math.max(1, Math.min(Math.floor(tail), 2000)) : 200;

  try {
    const text = manager.getSession(req.params.id)
      ? manager.getPlainText(req.params.id, lines)
      : bridgeRegistry.hasSession(req.params.id)
        ? bridgeRegistry.getPlainText(req.params.id, lines)
        : undefined;
    if (text === undefined) {
      res.status(404).json({ message: "Unknown terminal session." });
      return;
    }
    res.type("text/plain; charset=utf-8").send(text);
  } catch (error) {
    res.status(500).json({
      message: "Session text could not be read.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

// What a remote client needs before it can compose into this session: which
// agent is listening, whether it is mid-turn, whether it takes bracketed
// pastes, and any menu it is currently blocking on.
app.get("/api/sessions/:id/input-context", (req, res) => {
  const snapshot = readInputSnapshot(req.params.id);
  if (!snapshot) {
    res.status(404).json({ message: "Unknown terminal session." });
    return;
  }
  res.json(describeInputContext(snapshot.session, snapshot.text, snapshot.modes));
});

// Respond to a rendered Claude/Codex question semantically. Unlike /write,
// this endpoint revalidates the prompt fingerprint immediately before writing
// and chooses digits, arrows, Enter, text paste, or Escape for the exact TUI
// state. That makes mobile taps safe even while the terminal is redrawing.
app.post("/api/sessions/:id/prompt-response", async (req, res) => {
  const promptId = typeof req.body?.promptId === "string" ? req.body.promptId : "";
  const response = parsePromptResponse(req.body);
  if (!promptId || !response) {
    res.status(400).json({ message: "A prompt id and valid response action are required." });
    return;
  }

  try {
    res.json(await deliverPromptResponse(req.params.id, promptId, response));
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "StalePromptError" || name === "DuplicatePromptResponseError") {
      res.status(409).json({ message, stale: name === "StalePromptError" });
      return;
    }
    if (message === "Unknown terminal session.") {
      res.status(404).json({ message });
      return;
    }
    if (message === "Terminal session has exited.") {
      res.status(409).json({ message });
      return;
    }
    if (name === "PromptDeliveryError") {
      res.status(500).json({ message: "The response could not be delivered.", detail: message });
      return;
    }
    res.status(400).json({ message });
  }
});

// Everything a client needs to decide whether this terminal can show a rich
// agent view: what is running in it right now, whether it is already attached
// to an ACP conversation, and which conversations it could attach to. Nothing
// here starts an adapter or attaches on its own — the user taps.
app.get("/api/sessions/:id/agent", acpRoute(async (req, res) => {
  const session = allSessions().find((candidate) => candidate.id === req.params.id);
  if (!session) {
    res.status(404).json({ message: "Unknown terminal session." });
    return;
  }

  const agent = terminalAcpAgent(session);
  const acp = session.acpSessionId ? acpManager.session(session.acpSessionId) : undefined;
  if (session.acpSessionId && !acp) agentLinks.unlinkTerminal(session.id);

  // Adapters start lazily, and a stopped adapter knows about no conversations
  // at all — which would read to the person as "you have never worked here".
  // `prepare` is set by the tap that opens the picker, so the cost of starting
  // one is paid exactly when someone is waiting to choose.
  let startError: string | undefined;
  if (agent && req.query.prepare === "1" && !acp) {
    try {
      await acpManager.startAgent(agent);
      await acpManager.refreshSessions(agent);
    } catch (error) {
      startError = error instanceof Error ? error.message : String(error);
    }
  }

  const status = agent ? acpManager.state().agents.find((candidate) => candidate.id === agent) : undefined;

  res.json({
    sessionId: session.id,
    agent,
    agentSource: session.agentSource,
    activity: session.agentActivity,
    acpSessionId: acp ? session.acpSessionId : undefined,
    acpSession: acp,
    attach: {
      supported: Boolean(agent) && Boolean(status?.available),
      agentState: status?.state,
      reason: !agent
        ? "No Claude or Codex session is running in this terminal."
        : !status?.available
          ? status?.lastError ?? "The ACP adapter for this agent is not installed."
          : startError ?? (status.state === "error" ? status.lastError : undefined),
      candidates: agent ? agentLinkCandidates(status, session.cwd) : []
    }
  });
}));

// Open the rich agent view for this terminal. With a candidate id this loads
// that existing conversation's typed history; without one it starts a fresh
// ACP conversation in the terminal's directory. The terminal keeps running
// either way — this adds a second surface, it does not seize the first.
app.post("/api/sessions/:id/agent/attach", acpRoute(async (req, res) => {
  const session = allSessions().find((candidate) => candidate.id === req.params.id);
  if (!session) {
    res.status(404).json({ message: "Unknown terminal session." });
    return;
  }

  const agent = terminalAcpAgent(session) ?? requireAcpAgent(req.body?.agent);
  const existing = session.acpSessionId ? acpManager.session(session.acpSessionId) : undefined;
  if (existing && existing.state !== "closed" && existing.state !== "error") {
    res.json({ session, acpSession: existing, acp: acpManager.state() });
    return;
  }

  const remoteSessionId = optionalAcpString(req.body?.remoteSessionId, "Conversation id", 8_192);
  const acpSession = remoteSessionId
    ? await acpManager.loadSession({
        agent,
        sessionId: remoteSessionId,
        cwd: optionalAcpString(req.body?.cwd, "Working directory") ?? session.cwd,
        mode: req.body?.mode === "resume" ? "resume" : "load"
      })
    : await acpManager.createSession({
        agent,
        cwd: optionalAcpString(req.body?.cwd, "Working directory") ?? session.cwd
      });

  agentLinks.link(session.id, acpSession.id);
  const decorated = decorateSession(session);
  broadcast({ type: "session", session: decorated });
  res.status(201).json({ session: decorated, acpSession, acp: acpManager.state() });
}));

// Forget the pairing. The ACP conversation itself is only closed when asked,
// so detaching from a terminal never silently discards agent work.
app.delete("/api/sessions/:id/agent/attach", acpRoute(async (req, res) => {
  const acpSessionId = agentLinks.unlinkTerminal(requireAcpString(req.params.id, "Session id", 12_000));
  if (acpSessionId && req.query.close === "1") {
    await acpManager.closeSession(acpSessionId).catch(() => undefined);
  }

  const session = allSessions().find((candidate) => candidate.id === req.params.id);
  if (session) broadcast({ type: "session", session });
  res.json({ session, acp: acpManager.state() });
}));

// The slash commands this session would accept — the agent's built-ins plus
// the project's and the user's own command files.
app.get("/api/sessions/:id/commands", async (req, res) => {
  const snapshot = readInputSnapshot(req.params.id);
  if (!snapshot) {
    res.status(404).json({ message: "Unknown terminal session." });
    return;
  }

  const context = describeInputContext(snapshot.session, snapshot.text, snapshot.modes);
  try {
    res.json({
      agent: context.agent,
      agentLabel: context.agentLabel,
      cwd: context.cwd,
      commands: await listSlashCommands(context.agent, context.cwd)
    });
  } catch (error) {
    res.status(500).json({
      message: "Slash commands could not be listed.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

// Fuzzy file lookup under the session's working directory, backing `@file`
// mentions from clients that cannot see the host filesystem.
app.get("/api/sessions/:id/files", async (req, res) => {
  const snapshot = readInputSnapshot(req.params.id);
  if (!snapshot) {
    res.status(404).json({ message: "Unknown terminal session." });
    return;
  }

  const limit = Number(req.query.limit);
  try {
    res.json({
      cwd: snapshot.session.cwd,
      files: await searchFiles(
        snapshot.session.cwd,
        typeof req.query.q === "string" ? req.query.q : "",
        Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 100)) : 30
      )
    });
  } catch (error) {
    res.status(500).json({
      message: "Files could not be listed.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

// Send a composed message to the session. Unlike /write (raw bytes) this
// knows how the running program wants text delivered.
app.post("/api/sessions/:id/compose", async (req, res) => {
  const session = allSessions().find((candidate) => candidate.id === req.params.id);
  if (!session) {
    res.status(404).json({ message: "Unknown terminal session." });
    return;
  }
  if (session.status !== "running") {
    res.status(409).json({ message: "Terminal session has exited." });
    return;
  }

  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const submit = req.body?.submit !== false;
  const requested = optionalString(req.body?.mode);
  const mode = requested === "paste" || requested === "raw" ? requested : "auto";

  if (!text && !submit) {
    res.status(400).json({ message: "Nothing to send." });
    return;
  }

  try {
    res.json(await deliverComposedInput(session.id, text, submit, mode));
  } catch (error) {
    res.status(500).json({
      message: "Composed input could not be delivered.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/orchestrator", (_req, res) => {
  res.json(orchestrator.status());
});

app.post("/api/orchestrator/start", async (req, res) => {
  const agent = optionalString(req.body?.agent);
  if (agent !== "claude" && agent !== "codex") {
    res.status(400).json({ message: 'Orchestrator agent must be "claude" or "codex".' });
    return;
  }

  try {
    res.json(await orchestrator.start(agent as OrchestratorAgent, { restart: req.body?.restart === true }));
  } catch (error) {
    res.status(400).json({
      message: "Orchestrator could not be started.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/api/orchestrator/stop", async (_req, res) => {
  res.json(await orchestrator.stop());
});

app.get("/api/projects", (_req, res) => {
  res.json(projectStore.list());
});

// Fire-and-forget notification fanned out to every connected client (web +
// mobile), which play a sound/haptic. Meant for desktop-side automation like
// Claude Code hooks: curl -X POST http://127.0.0.1:10001/api/notify.
app.post("/api/notify", (req, res) => {
  // Query params are accepted alongside the JSON body so shell hooks can use
  // a bare `curl -X POST ".../api/notify?sound=done"` without JSON quoting.
  const title = optionalString(req.body?.title) ?? optionalString(req.query?.title);
  const body = optionalString(req.body?.body) ?? optionalString(req.query?.body);
  const sound = optionalString(req.body?.sound) ?? optionalString(req.query?.sound);
  // Hooks can attribute the notification to their own tab by passing the
  // WT_SESSION guid, e.g. `curl -X POST ".../api/notify?sessionId=%WT_SESSION%"`.
  const sessionId = optionalString(req.body?.sessionId) ?? optionalString(req.query?.sessionId);
  const session = sessionId ? allSessions().find((candidate) => candidate.id === sessionId) : undefined;
  emitNotification({ origin: "api", title, body, sound, sessionId: session?.id, sessionTitle: session?.title });
  res.status(204).end();
});

// Recent notification history so clients that were disconnected (mobile in
// the background) can catch up on reconnect. `since` is epoch milliseconds.
app.get("/api/notifications", (req, res) => {
  const since = Number(req.query.since);
  res.json(notificationCenter.list(Number.isFinite(since) ? since : undefined));
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    pid: serverInfo.pid,
    port: serverInfo.port,
    startedAt: serverInfo.startedAt,
    sessions: allSessions().length
  });
});

app.post("/api/projects", (req, res) => {
  try {
    const project = projectStore.create(String(req.body?.name ?? ""), String(req.body?.cwd ?? ""));
    reconcileProjects();
    broadcast({ type: "projects", projects: projectStore.list() });
    res.status(201).json(project);
  } catch (error) {
    res.status(400).json({
      message: "Project could not be created.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/projects/recent", (_req, res) => {
  res.json(projectStore.recents());
});

app.patch("/api/projects/order", (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    res.status(400).json({ message: "Project order requires an ids array of strings." });
    return;
  }

  const projects = projectStore.reorder(ids);
  broadcast({ type: "projects", projects });
  res.json(projects);
});

app.delete("/api/projects/:id", (req, res) => {
  for (const session of allSessions()) {
    if (session.projectId !== req.params.id) {
      continue;
    }
    if (bridgeRegistry.hasSession(session.id)) {
      bridgeRegistry.kill(session.id);
    } else {
      manager.kill(session.id);
    }
  }

  projectStore.remove(req.params.id);
  broadcast({ type: "projects", projects: projectStore.list() });
  res.status(204).end();
});

app.post("/api/sessions", async (req, res) => {
  try {
    const session = await createSession(normalizeCreateSessionOptions(req.body ?? {}));
    res.status(201).json(session);
  } catch (error) {
    res.status(400).json({
      message: "Terminal session could not be created.",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

app.patch("/api/sessions/:id", (req, res) => {
  const title = String(req.body?.title ?? "");
  const session = bridgeRegistry.hasSession(req.params.id)
    ? bridgeRegistry.rename(req.params.id, title)
    : manager.rename(req.params.id, title);
  res.json(session);
});

app.get("/api/sessions/:id/export", (req, res) => {
  const sessionExport = getSessionExport(req.params.id);
  if (!sessionExport) {
    res.status(404).json({ message: "Unknown terminal session." });
    return;
  }

  const format = String(req.query.format ?? "ansi").toLowerCase();
  const baseName = safeExportName(`${sessionExport.session.title}-${sessionExport.session.id}`);

  if (format === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}.json"`);
    res.json(sessionExport);
    return;
  }

  if (format === "screen") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}-screen.ansi"`);
    res.send(sessionExport.screen ?? sessionExport.transcript);
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${baseName}.ansi"`);
  res.send(sessionExport.transcript);
});

app.get("/api/peers/:port/sessions/:id/export", async (req, res) => {
  const port = Number(req.params.port);
  const peer = peerHosts.find((candidate) => candidate.server.port === port);
  if (!peer) {
    res.status(404).json({ message: "Peer terminal host is not discovered." });
    return;
  }

  const format = encodeURIComponent(String(req.query.format ?? "ansi"));
  const url = `${peer.url}/api/sessions/${encodeURIComponent(req.params.id)}/export?format=${format}`;
  const response = await fetch(url, {
    headers: {
      Accept: "text/plain, application/json"
    }
  });

  if (!response.ok) {
    res.status(response.status).json({ message: "Peer export failed." });
    return;
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition");
  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }
  if (disposition) {
    res.setHeader("Content-Disposition", disposition);
  }

  res.send(Buffer.from(await response.arrayBuffer()));
});

app.delete("/api/sessions/:id", (req, res) => {
  if (bridgeRegistry.hasSession(req.params.id)) {
    bridgeRegistry.kill(req.params.id);
  } else {
    manager.kill(req.params.id);
  }
  res.status(204).end();
});

app.post("/api/sessions/:id/write", (req, res) => {
  writeSessionInput(req.params.id, String(req.body?.data ?? ""));
  res.status(204).end();
});

// Saves an uploaded image next to the terminals and returns its local path;
// with ?paste=1 the path is also inserted into the session as a bracketed
// paste (+ trailing space). Claude Code and Codex both turn a pasted image
// path into an attached image, so this is the compatible way for remote
// clients to "paste pictures" into terminal AI sessions.
app.post(
  "/api/sessions/:id/attachments",
  express.raw({ type: () => true, limit: "32mb" }),
  async (req, res) => {
    const sessionId = req.params.id;
    if (!allSessions().some((session) => session.id === sessionId)) {
      res.status(404).json({ message: "Unknown terminal session." });
      return;
    }

    const data = req.body as Buffer;
    if (!Buffer.isBuffer(data) || data.length === 0) {
      res.status(400).json({ message: "Attachment body is empty." });
      return;
    }

    const mime = (req.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!mime.startsWith("image/")) {
      res.status(415).json({ message: "Only image attachments are supported." });
      return;
    }
    const filenameHint = typeof req.query.filename === "string" ? req.query.filename : "";
    const hintedExtension = path.extname(filenameHint).replace(/^\./, "").toLowerCase();
    const supportedExtensions = new Set(Object.values(EXTENSION_BY_MIME));
    const extension = (supportedExtensions.has(hintedExtension) ? hintedExtension : undefined) ?? EXTENSION_BY_MIME[mime] ?? "png";

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    const filePath = path.join(ATTACHMENTS_DIR, `img-${stamp}-${randomBytes(4).toString("hex")}.${extension}`);

    try {
      mkdirSync(ATTACHMENTS_DIR, { recursive: true });
      await writeFile(filePath, data);
    } catch (error) {
      res.status(500).json({
        message: "Could not save the attachment.",
        detail: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    void pruneAttachments();

    let pasted = false;
    if (String(req.query.paste ?? "") === "1") {
      const quoted = filePath.includes(" ") ? `"${filePath}"` : filePath;
      try {
        const delivered = await deliverComposedInput(sessionId, `${quoted} `, false, "auto");
        pasted = delivered.method !== "none";
      } catch (error) {
        await unlink(filePath).catch(() => undefined);
        res.status(500).json({
          message: "The image was saved, but could not be pasted into the session.",
          detail: error instanceof Error ? error.message : String(error)
        });
        return;
      }
    }

    res.status(201).json({ path: filePath, pasted });
  }
);

app.post("/api/sessions/:id/resize", (req, res) => {
  if (bridgeRegistry.hasSession(req.params.id)) {
    bridgeRegistry.resize(req.params.id, Number(req.body?.cols), Number(req.body?.rows));
  } else {
    manager.resize(req.params.id, Number(req.body?.cols), Number(req.body?.rows));
  }
  res.status(204).end();
});

app.post("/api/host/refresh", async (_req, res) => {
  await refreshHostProcesses();
  res.json({ hostProcesses, peerHosts });
});

wss.on("connection", (ws) => {
  send(ws, {
    type: "hello",
    sessions: allSessions(),
    profiles: manager.profiles,
    hostProcesses,
    peerHosts,
    projects: projectStore.list(),
    server: serverInfo,
    bridgeCommands: getBridgeCommands(),
    orchestrator: orchestrator.status(),
    acp: acpManager.state()
  });

  ws.on("message", (raw) => {
    const message = parseMessage(raw);
    if (!message) {
      send(ws, { type: "error", message: "Ignoring malformed WebSocket message." });
      return;
    }

    safeAction(ws, async () => {
      switch (message.type) {
        case "subscribe": {
          const slots = clientSubscriptions.get(ws) ?? new Map<string, string>();
          slots.set(message.slot ?? "main", message.sessionId);
          clientSubscriptions.set(ws, slots);
          flushOutputs();
          if (peerProxy.isPeerTarget(message.sessionId)) {
            peerProxy.forward(ws, message);
            break;
          }
          if (bridgeRegistry.hasSession(message.sessionId)) {
            const snapshot = bridgeRegistry.getSnapshot(message.sessionId);
            send(ws, {
              type: "snapshot",
              sessionId: message.sessionId,
              ...snapshot
            });
            break;
          }
          const snapshot = manager.getSnapshot(message.sessionId);
          send(ws, {
            type: "snapshot",
            sessionId: message.sessionId,
            ...snapshot
          });
          break;
        }
        case "unsubscribe":
          clientSubscriptions.get(ws)?.delete(message.slot ?? "main");
          break;
        case "input":
          if (peerProxy.isPeerTarget(message.sessionId)) {
            peerProxy.forward(ws, message);
            break;
          }
          if (bridgeRegistry.hasSession(message.sessionId)) {
            bridgeRegistry.write(message.sessionId, message.data);
            break;
          }
          manager.write(message.sessionId, message.data);
          break;
        case "resize":
          if (peerProxy.isPeerTarget(message.sessionId)) {
            peerProxy.forward(ws, message);
            break;
          }
          if (bridgeRegistry.hasSession(message.sessionId)) {
            bridgeRegistry.resize(message.sessionId, message.cols, message.rows);
            break;
          }
          manager.resize(message.sessionId, message.cols, message.rows);
          break;
        case "create":
          await createSession(normalizeCreateSessionOptions(message));
          break;
        case "rename":
          if (peerProxy.isPeerTarget(message.sessionId)) {
            peerProxy.forward(ws, message);
            break;
          }
          if (bridgeRegistry.hasSession(message.sessionId)) {
            bridgeRegistry.rename(message.sessionId, message.title);
            break;
          }
          manager.rename(message.sessionId, message.title);
          break;
        case "kill":
          if (peerProxy.isPeerTarget(message.sessionId)) {
            peerProxy.forward(ws, message);
            break;
          }
          if (bridgeRegistry.hasSession(message.sessionId)) {
            bridgeRegistry.kill(message.sessionId);
            break;
          }
          manager.kill(message.sessionId);
          break;
        case "refresh-host":
          await refreshHostProcesses();
          break;
      }
    });
  });

  ws.on("close", () => {
    peerProxy.dispose(ws);
  });
});

bridgeWss.on("connection", (ws) => {
  bridgeRegistry.attach(ws);
});

async function attachClientApp(): Promise<void> {
  const root = process.cwd();
  const staticMode = process.argv.includes("--static") || process.env.NODE_ENV === "production";

  if (staticMode) {
    const clientDist = path.resolve(root, "dist", "client");
    app.use(express.static(clientDist));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
    return;
  }

  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    server: {
      middlewareMode: true
    },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

async function main(): Promise<void> {
  // Intentionally no default managed session: the session list should be a
  // faithful mirror of real terminal tabs, not seeded with a phantom shell.
  hostProcesses = await discoverHostTerminals();
  await attachClientApp();

  const host = getHost();
  const port = await listenOnAvailablePort(server, host, getStartPort());
  accessToken = getAccessToken(host);
  serverInfo = {
    pid: process.pid,
    host,
    port,
    startedAt,
    urls: getServerAccessUrls(host, port)
  };
  recordServerInfo();
  peerHosts = await discoverTerminalWebPeers(serverInfo, getStartPort());
  startHostRefreshLoop();
  startAgentSweepLoop();
  startProjectRefreshLoop();

  console.log(`Terminal Web Host listening at ${serverInfo.urls[0]?.url ?? `http://${host}:${port}`}`);
}

// Where we actually listen, persisted next to the package. When the default
// port is owned by something else and we walk up, the native bridge follows
// us here instead of dialing 10001 forever.
const serverInfoPath = process.env.TERMINAL_WEB_SERVER_INFO_PATH
  ? path.resolve(process.env.TERMINAL_WEB_SERVER_INFO_PATH)
  : path.resolve(process.cwd(), ".terminal-web-server.json");

function recordServerInfo(): void {
  try {
    writeFileSync(
      serverInfoPath,
      `${JSON.stringify({ pid: serverInfo.pid, host: serverInfo.host, port: serverInfo.port, startedAt }, undefined, 2)}\n`
    );
  } catch (error) {
    console.warn("Could not record server info:", error instanceof Error ? error.message : String(error));
  }
}

function removeServerInfo(): void {
  try {
    // Only remove our own record; a replacement server may already own it.
    const recorded = JSON.parse(readFileSync(serverInfoPath, "utf8"));
    if (recorded?.pid === process.pid) {
      unlinkSync(serverInfoPath);
    }
  } catch {
    // Missing or unreadable is fine on shutdown.
  }
}

process.on("SIGINT", () => {
  acpManager.dispose();
  manager.dispose();
  removeServerInfo();
  server.close(() => process.exit(0));
});

process.on("exit", () => {
  removeServerInfo();
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
