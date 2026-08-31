import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const baseUrl = new URL(process.env.TERMINAL_WEB_URL ?? "http://127.0.0.1:10003");
const token = (await readFile(new URL("../.terminal-web-token", import.meta.url), "utf8")).trim();
const sessionId = `smoke-replay-${randomUUID()}`;
const startedAt = Date.now();
const payload = Buffer.from(JSON.stringify({ v: 1, agent: "claude", state: "active" }), "utf8").toString("base64url");
const marker = `\x1b]1337;TerminalWeb.Agent=${payload}\x1b\\`;
const replay = [
  marker,
  "Earlier task finished\x07",
  "Choose a release channel",
  "❯ 1. Internal",
  "  2. Production",
  "Enter to confirm · Esc to cancel"
].join("\r\n");

const socketUrl = new URL(baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
socketUrl.pathname = "/bridge";
socketUrl.search = "";

const socket = new WebSocket(socketUrl);
const messages = [];
socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the live bridge state.");
}

async function api(pathname) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}`);
  return response.json();
}

try {
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(JSON.stringify({
    type: "register",
    session: {
      id: sessionId,
      title: "Bro CLI",
      shell: "pwsh.exe",
      args: [],
      cwd: process.cwd(),
      source: "bridged",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cols: 100,
      rows: 30,
      bufferedBytes: 0
    },
    replay
  }));

  const registered = await waitFor(() => messages.find((message) => message.type === "registered"));
  assert.equal(registered.replay, false);
  assert.equal(registered.session.agent, "claude");
  assert.equal(registered.session.agentSource, "osc");

  const context = await waitFor(async () => {
    const value = await api(`/api/sessions/${encodeURIComponent(sessionId)}/input-context`);
    return value.prompt ? value : undefined;
  });
  assert.equal(context.agent, "claude");
  assert.equal(context.prompt.kind, "single-select");
  assert.deepEqual(context.prompt.options.map((option) => option.label), ["Internal", "Production"]);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const notifications = await api(`/api/notifications?since=${startedAt}`);
  const ours = notifications.filter((notification) => notification.sessionId === sessionId);
  assert.equal(ours.length, 1);
  assert.equal(ours[0].origin, "api");
  assert.match(ours[0].title ?? "", /needs input/i);

  console.log("Live bridge replay restored Claude identity, the actionable question, and one non-duplicated attention alert.");
} finally {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "exit", sessionId, exitCode: 0 }));
  }
  socket.close();
}
