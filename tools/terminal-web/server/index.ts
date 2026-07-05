import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { BridgeRegistry } from "./bridge-registry.js";
import { discoverHostTerminals } from "./host-discovery.js";
import { discoverTerminalWebPeers } from "./peer-discovery.js";
import { PeerProxy } from "./peer-proxy.js";
import { listenOnAvailablePort } from "./ports.js";
import { ProjectStore } from "./projects.js";
import { TerminalManager } from "./terminal-manager.js";
import type {
  BridgeCommandInfo,
  ClientMessage,
  HostTerminalProcess,
  ServerInfo,
  ServerMessage,
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
const bridgeRegistry = new BridgeRegistry();
const projectStore = new ProjectStore();
const peerProxy = new PeerProxy(() => peerHosts);

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
}

interface ResolvedSessionCommand {
  profile?: TerminalProfile;
  title: string;
  shell: string;
  args: string[];
  cwd: string;
}

const MAX_BUFFERED_OUTPUT_BYTES = 128 * 1024;
let pendingOutputs = new Map<string, PendingOutput>();
let outputFlushTimer: ReturnType<typeof setTimeout> | undefined;

// Which session each client is watching (its last "subscribe"). Full output
// bytes are only streamed to clients subscribed to that session; everyone else
// gets a lightweight throttled "activity" ping so unread badges still tick.
// Without this, every session's output was broadcast to every client, which
// saturated slow (mobile) connections as soon as a few sessions were busy and
// starved the active terminal's own stream.
const clientSubscriptions = new WeakMap<WebSocket, string>();
const ACTIVITY_PING_INTERVAL_MS = 1000;
const lastActivityPingAt = new Map<string, number>();

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
  const fallbackProfile = requestedProfile ?? manager.profiles[0];
  const explicitShell = options.shell;
  const shell = explicitShell ?? fallbackProfile?.shell;

  if (!shell) {
    throw new Error("No terminal shell profile is available.");
  }

  return {
    profile: fallbackProfile,
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
    options.cwd = projectStore.list().find((project) => project.id === options.projectId)?.cwd;
  }

  const mode = getSessionCreateMode();
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
      if (clientSubscriptions.get(client) === sessionId) {
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
  return [...manager.listSessions(), ...bridgeRegistry.listSessions()];
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

async function refreshHostProcesses(): Promise<void> {
  hostProcesses = await discoverHostTerminals();
  peerHosts = await discoverTerminalWebPeers(serverInfo, getStartPort());
  broadcast({ type: "host", hostProcesses, peerHosts });
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
  queueOutput(event);
});

manager.on("session", (session) => {
  broadcast({ type: "session", session });
});

manager.on("sessions", (sessions) => {
  broadcast({ type: "sessions", sessions: allSessions() });
});

manager.on("exit", (event) => {
  flushOutputs();
  lastActivityPingAt.delete(event.sessionId);
  broadcast({
    type: "exit",
    sessionId: event.sessionId,
    exitCode: event.exitCode,
    signal: event.signal,
    session: event.session
  });
});

bridgeRegistry.on("output", (event) => {
  queueOutput(event);
});

bridgeRegistry.on("session", (session) => {
  broadcast({ type: "session", session });
});

bridgeRegistry.on("sessions", () => {
  broadcast({ type: "sessions", sessions: allSessions() });
});

bridgeRegistry.on("exit", (event) => {
  flushOutputs();
  lastActivityPingAt.delete(event.sessionId);
  broadcast({
    type: "exit",
    sessionId: event.sessionId,
    exitCode: event.exitCode,
    signal: event.signal,
    session: event.session
  });
});

installWebSocketHeartbeat(wss);
installWebSocketHeartbeat(bridgeWss);

app.use(express.json({ limit: "1mb" }));

app.use("/api", (req, res, next) => {
  if (isAuthorizedRequest(req)) {
    next();
    return;
  }
  res.status(401).json({ message: "Terminal web access token is required." });
});

app.get("/api/bootstrap", (_req, res) => {
  res.json({
    sessions: allSessions(),
    profiles: manager.profiles,
    hostProcesses,
    peerHosts,
    projects: projectStore.list(),
    server: serverInfo,
    bridgeCommands: getBridgeCommands()
  });
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
  broadcast({ type: "notify", title, body, sound });
  res.status(204).end();
});

app.post("/api/projects", (req, res) => {
  try {
    const project = projectStore.create(String(req.body?.name ?? ""), String(req.body?.cwd ?? ""));
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
  if (bridgeRegistry.hasSession(req.params.id)) {
    bridgeRegistry.write(req.params.id, String(req.body?.data ?? ""));
  } else {
    manager.write(req.params.id, String(req.body?.data ?? ""));
  }
  res.status(204).end();
});

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
    bridgeCommands: getBridgeCommands()
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
          clientSubscriptions.set(ws, message.sessionId);
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
  peerHosts = await discoverTerminalWebPeers(serverInfo, getStartPort());
  startHostRefreshLoop();

  console.log(`Terminal Web Host listening at ${serverInfo.urls[0]?.url ?? `http://${host}:${port}`}`);
}

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
