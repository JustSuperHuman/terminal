import assert from "node:assert/strict";
import { mock } from "bun:test";
import { TerminalSocket } from "../src/lib/socket.ts";
import { groupSessions } from "../src/lib/sessionOrder.ts";

// Deterministic network failures: no sleeps, network, tokens, or live sessions.
let now = 0;
let nextTimer = 0;
const timers = new Map();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realWebSocket = globalThis.WebSocket;
globalThis.setTimeout = (callback, delay) => {
  const id = ++nextTimer;
  timers.set(id, { at: now + delay, callback });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
function advance(ms) {
  const end = now + ms;
  while (true) {
    const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    now = due[1].at;
    timers.delete(due[0]);
    due[1].callback();
  }
  now = end;
}
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url) { this.url = url; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(value) { if (this.throwOnSend) throw new Error("network lost"); this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = FakeSocket;
const endpoint = { id: "test", httpBase: "http://test", host: "test", wsUrl: "ws://test/ws" };
const hello = { type: "hello", heartbeat: true, sessions: [], projects: [], profiles: [] };
const client = new TerminalSocket();
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
const latest = () => FakeSocket.instances.at(-1);
try {
  client.configure(endpoint);
  client.connect();
  const first = latest();
  first.open();
  check("input waits for hello", () => {
    assert.equal(client.currentStatus, "connecting");
    assert.equal(client.send({ type: "input", sessionId: "a", data: "x" }), false);
  });
  advance(10000);
  check("open socket with missing hello times out", () => assert.equal(client.currentStatus, "closed"));
  advance(1200);
  latest().open(); latest().message(hello);
  check("reconnect completes after hello", () => assert.equal(client.currentStatus, "open"));
  advance(15000);
  check("heartbeat traverses the same socket", () => assert.deepEqual(latest().sent.at(-1), { type: "ping" }));
  latest().message({ type: "pong" });
  advance(10000);
  check("pong cancels the deadline", () => assert.equal(client.currentStatus, "open"));
  advance(15000);
  check("half-open connection recovers without close event", () => assert.equal(client.currentStatus, "closed"));
  advance(1200);
  latest().open(); latest().message(hello);
  const stale = latest();
  const staleHandler = stale.onmessage;
  let received = 0;
  const unsubscribe = client.onMessage(() => received++);
  client.resume();
  check("foreground replaces stale OPEN socket", () => {
    assert.notEqual(latest(), stale);
    assert.equal(client.currentStatus, "connecting");
  });
  staleHandler({ data: JSON.stringify({ type: "sessions", sessions: [{ id: "wrong" }] }) });
  check("old socket cannot mutate restored state", () => assert.equal(received, 1));
  latest().open(); latest().message(hello);
  latest().throwOnSend = true;
  check("send failure reports failure and starts recovery", () => {
    assert.equal(client.send({ type: "input", sessionId: "a", data: "x" }), false);
    assert.equal(client.currentStatus, "closed");
  });
  advance(1200);
  latest().open(); latest().message({ ...hello, heartbeat: undefined });
  advance(60000);
  check("older hosts do not require heartbeat support", () => assert.equal(client.currentStatus, "open"));
  latest().onerror();
  check("error without close triggers retry", () => assert.equal(client.currentStatus, "closed"));
  client.disconnect();
  const count = FakeSocket.instances.length;
  advance(60000); client.resume();
  check("explicit disconnect cancels timers and resume", () => {
    assert.equal(FakeSocket.instances.length, count);
    assert.equal(timers.size, 0);
  });
  client.configure(endpoint); client.connect();
  const configuredSocket = latest();
  client.configure({ ...endpoint, wsUrl: "ws://other/ws" });
  advance(60000);
  check("changing hosts cancels old connection timeout", () => {
    assert.equal(configuredSocket.readyState, 3);
    assert.equal(client.currentStatus, "idle");
  });
  unsubscribe();

  const projects = [{ id: "z", name: "Desktop first", cwd: "F:\\z" }, { id: "a", name: "Desktop second", cwd: "F:\\a" }];
  const sessions = [
    { id: "a2", projectId: "a", cwd: "F:\\a", createdAt: "2026-01-02", updatedAt: "0" },
    { id: "z1", cwd: "f:/Z/", createdAt: "2026-01-01", updatedAt: "1" },
    { id: "a1", projectId: "a", cwd: "F:\\a\\child", createdAt: "2026-01-01", updatedAt: "2" },
  ];
  const ids = (items) => groupSessions(items, projects).flatMap((group) => group.sessions.map((s) => s.id));
  check("desktop project identity, names, order, and Windows path normalization", () => {
    assert.deepEqual(ids(sessions), ["z1", "a1", "a2"]);
    assert.equal(groupSessions(sessions, projects)[0].label, "Desktop first");
  });
  check("1000 simultaneous output updates never reorder rows", () => {
    for (let i = 0; i < 1000; i++) {
      const updated = sessions.map((s, n) => ({ ...s, updatedAt: String(i * (n + 1)), title: `title-${i}-${n}`, agentActivity: i % 2 ? "working" : "awaiting" })).reverse();
      assert.deepEqual(ids(updated), ["z1", "a1", "a2"]);
    }
  });
  check("older hosts group by normalized directory", () => {
    assert.equal(groupSessions([{ ...sessions[0], cwd: "F:\\Test\\" }, { ...sessions[1], cwd: "f:/test" }], []).length, 1);
  });
  console.log(`${checks} mobile reliability checks passed`);
} finally {
  client.disconnect();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.WebSocket = realWebSocket;
}

const stored = new Map();
mock.module("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key) => { await Promise.resolve(); return stored.get(key) ?? null; },
  setItem: async (key, value) => { await Promise.resolve(); stored.set(key, value); },
} }));
const { saveDraft, loadDraft } = await import("../src/lib/storage.ts");
await Promise.all([saveDraft("host", "a", "draft A"), saveDraft("host", "b", "draft B")]);
assert.equal(await loadDraft("host", "a"), "draft A");
assert.equal(await loadDraft("host", "b"), "draft B");
console.log("PASS simultaneous draft saves preserve both sessions");
const flush = saveDraft("host", "a", "latest before switching");
assert.equal(await loadDraft("host", "a"), "latest before switching");
await flush;
await saveDraft("host", "a", "");
assert.equal(await loadDraft("host", "b"), "draft B");
console.log("PASS draft restore waits for flush; clearing one draft preserves another");
