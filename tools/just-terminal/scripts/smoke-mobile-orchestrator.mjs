import assert from "node:assert/strict";
import { SessionLaunchDirectory } from "../src/lib/sessionLaunchDirectory.ts";
import { mergeOrchestratorItem, mergeOrchestratorStatus } from "../src/lib/orchestratorState.ts";
import { requestOrchestrator } from "../src/lib/orchestratorApi.ts";

let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
const directory = new SessionLaunchDirectory();
directory.restore("F:\\saved");
await check("saved cwd is only the initial fallback", () => assert.equal(directory.cwd, "F:\\saved"));
directory.select({ id: "a", cwd: "F:\\project-a" });
directory.restore("F:\\late-storage-result");
await check("selected session wins over late storage hydration", () => assert.equal(directory.cwd, "F:\\project-a"));
directory.select({ id: "a", cwd: "F:\\project-a\\src" });
await check("launch follows live cwd changes", () => assert.equal(directory.cwd, "F:\\project-a\\src"));
directory.choose("F:\\manual");
directory.select({ id: "a", cwd: "F:\\project-a\\src" });
await check("explicit directory survives updates to the same selection", () => assert.equal(directory.cwd, "F:\\manual"));
directory.select({ id: "b", cwd: "J:\\project-b" });
await check("selecting another session replaces the manual directory", () => assert.equal(directory.cwd, "J:\\project-b"));
directory.select(undefined);
await check("opening orchestrator or closing a terminal keeps the last directory", () => assert.equal(directory.cwd, "J:\\project-b"));
directory.choose(undefined);
directory.select({ id: "b", cwd: "J:\\project-b" });
await check("explicit host default remains selectable", () => assert.equal(directory.cwd, undefined));

const user = { id: "user", rev: 1, seq: 1, role: "user", text: "Check my sessions", status: "done", at: "2026-01-01", turnId: "t" };
const assistant = { ...user, id: "assistant", role: "assistant", seq: 2, text: "Checking", status: "streaming" };
const initial = { state: "running", seq: 2, transcript: [user, assistant] };
let current = mergeOrchestratorItem(initial, { ...assistant, rev: 2, seq: 3, text: "Checked both projects", status: "done" }, 3);
await check("streamed updates replace one item without moving it", () => {
  assert.deepEqual(current.transcript.map((item) => item.id), ["user", "assistant"]);
  assert.equal(current.transcript[1].text, "Checked both projects");
});
current = mergeOrchestratorItem(current, assistant, 2);
await check("stale item revisions cannot roll back text", () => assert.equal(current.transcript[1].rev, 2));
current = mergeOrchestratorStatus(current, initial);
await check("late REST response cannot overwrite newer stream", () => assert.equal(current.transcript[1].text, "Checked both projects"));
current = mergeOrchestratorStatus(current, { state: "idle", seq: 4 });
await check("status-only response retains shared conversation", () => { assert.equal(current.state, "idle"); assert.equal(current.transcript.length, 2); });
const cleared = { state: "idle", seq: 5, transcript: [] };
await check("clear tombstone rejects late snapshots and events", () => {
  assert.deepEqual(mergeOrchestratorStatus(cleared, initial, 5).transcript, []);
  assert.deepEqual(mergeOrchestratorItem(cleared, assistant, 2, 5).transcript, []);
});
await check("fresh full snapshot reconciles deleted history", () => assert.deepEqual(mergeOrchestratorStatus(current, cleared).transcript, []));
await check("multiple cancelled items at the same sequence all arrive", () => {
  let next = mergeOrchestratorItem(current, { ...assistant, seq: 6, rev: 3, status: "cancelled" }, 6);
  next = mergeOrchestratorItem(next, { ...assistant, id: "tool", seq: 6, rev: 1, role: "tool", status: "cancelled" }, 6);
  assert.equal(next.transcript.length, 3);
  assert.equal(next.transcript[1].status, "cancelled");
});

const realFetch = globalThis.fetch;
const calls = [];
const endpoint = { id: "test", httpBase: "http://desktop.test", host: "desktop.test", wsUrl: "ws://desktop.test/ws" };
try {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(initial), { status: 202, headers: { "Content-Type": "application/json" } });
  };
  await requestOrchestrator(endpoint, "status");
  await requestOrchestrator(endpoint, "send", "Check my sessions");
  await requestOrchestrator(endpoint, "cancel");
  await check("mobile uses the desktop transcript, send and cancel endpoints", () => {
    assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]), [
      ["GET", "/api/orchestrator"], ["POST", "/api/orchestrator/messages"], ["POST", "/api/orchestrator/cancel"],
    ]);
    assert.deepEqual(JSON.parse(calls[1].body), { text: "Check my sessions" });
  });
  let failedCalls = 0;
  globalThis.fetch = async () => { failedCalls++; throw new Error("network lost"); };
  await check("failed sends are never automatically replayed", async () => {
    await assert.rejects(() => requestOrchestrator(endpoint, "send", "only once"), /network lost/);
    assert.equal(failedCalls, 1);
  });
  globalThis.fetch = async () => new Response("", { status: 409 });
  await check("desktop busy conflict gives a recoverable explanation", async () => {
    await assert.rejects(() => requestOrchestrator(endpoint, "send", "next"), /already working/);
  });
  globalThis.fetch = async () => new Response("", { status: 404 });
  await check("older hosts show desktop connection guidance", async () => {
    await assert.rejects(() => requestOrchestrator(endpoint, "status"), /desktop terminal host/);
  });
} finally { globalThis.fetch = realFetch; }
console.log(`${checks} mobile directory and orchestrator checks passed`);
