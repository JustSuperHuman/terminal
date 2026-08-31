import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { BridgeRegistry } from "./bridge-registry.js";
import { TerminalAgentMetadataDetector } from "./terminal-agent-metadata.js";
import type { BridgeServerMessage, TerminalSessionSummary } from "./types.js";

function summary(): TerminalSessionSummary {
  return {
    id: "native-replay",
    title: "PowerShell",
    shell: "pwsh.exe",
    args: [],
    cwd: "C:\\work",
    source: "bridged",
    status: "running",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    cols: 100,
    rows: 30,
    bufferedBytes: 0
  };
}

function marker(agent: "claude" | "codex", state: "active" | "inactive"): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, agent, state }), "utf8").toString("base64url");
  return `\x1b]1337;TerminalWeb.Agent=${payload}\x1b\\`;
}

test("fresh native registration atomically restores output and runtime agent metadata", async () => {
  const sent: BridgeServerMessage[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(value: string) {
      sent.push(JSON.parse(value) as BridgeServerMessage);
    }
  } as unknown as WebSocket;
  const registry = new BridgeRegistry();
  const detector = new TerminalAgentMetadataDetector(({ sessionId, ...event }) => {
    registry.updateAgentPresence(sessionId, event);
  });
  const outputEvents: Array<{ replay?: boolean }> = [];
  registry.on("output", (event) => {
    outputEvents.push(event);
    detector.feed(event.sessionId, event.data);
  });

  const replay = `${marker("claude", "active")}Choose one\r\n❯ 1. Yes\r\n  2. No`;
  (registry as unknown as {
    register(socket: WebSocket, summary: TerminalSessionSummary, replay?: string): void;
  }).register(socket, summary(), replay);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(outputEvents.map((event) => event.replay), [true]);
  assert.equal(registry.listSessions()[0]?.agent, "claude");
  assert.equal(registry.listSessions()[0]?.agentSource, "osc");
  assert.match(registry.getPlainText("native-replay", 10), /Choose one/);
  const registered = sent.find((message) => message.type === "registered");
  assert.equal(registered?.type === "registered" ? registered.replay : undefined, false);
  assert.equal(registered?.type === "registered" ? registered.session.agent : undefined, "claude");
});
