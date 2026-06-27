import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
import { TerminalManager } from "./terminal-manager.js";
import type {
  BridgeCommandInfo,
  ClientMessage,
  HostTerminalProcess,
  ServerInfo,
  ServerMessage,
  TerminalHostPeer,
  TerminalSessionExport
} from "./types.js";

const startedAt = new Date().toISOString();
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const bridgeWss = new WebSocketServer({ noServer: true });
const manager = new TerminalManager();
const bridgeRegistry = new BridgeRegistry();
const peerProxy = new PeerProxy(() => peerHosts);

let hostProcesses: HostTerminalProcess[] = [];
let peerHosts: TerminalHostPeer[] = [];
let accessToken: string | undefined;
let serverInfo: ServerInfo = {
  pid: process.pid,
  host: "127.0.0.1",
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

const MAX_BUFFERED_OUTPUT_BYTES = 128 * 1024;
let pendingOutputs = new Map<string, PendingOutput>();
let outputFlushTimer: ReturnType<typeof setTimeout> | undefined;

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
  return getArgValue("--host") ?? process.env.TERMINAL_WEB_HOST ?? "127.0.0.1";
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

  for (const [sessionId, output] of outputs) {
    broadcast({
      type: "output",
      sessionId,
      seq: output.seq,
      data: output.data
    });
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
    server: serverInfo,
    bridgeCommands: getBridgeCommands()
  });
});

app.post("/api/sessions", (req, res) => {
  try {
    const session = manager.createSession(req.body ?? {});
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
          manager.createSession(message);
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
  manager.ensureDefaultSession();
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
