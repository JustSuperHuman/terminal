import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { AgentLinkRegistry, agentLinkCandidates } from "./agent-links.js";
import type { AcpAgentStatusView, AcpRemoteSessionView } from "./acp-types.js";
import type { TerminalSessionSummary } from "./types.js";

const root = path.resolve("/work/app");
const nested = path.resolve("/work/app/packages/web");
const sibling = path.resolve("/work/other");

function status(availableSessions: AcpRemoteSessionView[]): AcpAgentStatusView {
  return {
    id: "claude",
    label: "Claude Code",
    state: "ready",
    available: true,
    adapterVersion: "0.0.0",
    capabilities: {} as AcpAgentStatusView["capabilities"],
    authMethods: [],
    availableSessions
  };
}

function remote(sessionId: string, cwd: string, updatedAt: string): AcpRemoteSessionView {
  return { sessionId, cwd, additionalDirectories: [], updatedAt };
}

function summary(id: string): TerminalSessionSummary {
  return {
    id,
    title: id,
    shell: "pwsh.exe",
    args: [],
    cwd: root,
    source: "bridged",
    status: "running",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    cols: 120,
    rows: 32,
    bufferedBytes: 0
  };
}

test("candidates rank exact directories first, then recency, and drop unrelated work", () => {
  const candidates = agentLinkCandidates(
    status([
      remote("nested-new", nested, "2026-08-28T12:00:00.000Z"),
      remote("root-old", root, "2026-08-27T09:00:00.000Z"),
      remote("root-new", root, "2026-08-28T11:00:00.000Z"),
      remote("elsewhere", sibling, "2026-08-28T13:00:00.000Z")
    ]),
    root
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.sessionId),
    ["root-new", "root-old", "nested-new"]
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.exact),
    [true, true, false]
  );
});

test("a terminal deeper in the tree still finds the conversation started at the repo root", () => {
  const candidates = agentLinkCandidates(status([remote("root", root, "2026-08-28T10:00:00.000Z")]), nested);
  assert.deepEqual(candidates.map((candidate) => candidate.sessionId), ["root"]);
  assert.equal(candidates[0]!.exact, false);
});

test("no agent, no adapter, or no history means nothing to attach to", () => {
  assert.deepEqual(agentLinkCandidates(undefined, root), []);
  assert.deepEqual(agentLinkCandidates(status([]), root), []);
});

test("links are one-to-one and decorate only the terminal that owns them", () => {
  const links = new AgentLinkRegistry();
  const sessions = [summary("term-a"), summary("term-b")];

  assert.deepEqual(links.decorate(sessions), sessions);

  links.link("term-a", "acp-1");
  assert.equal(links.decorate(sessions)[0]!.acpSessionId, "acp-1");
  assert.equal(links.decorate(sessions)[1]!.acpSessionId, undefined);
  assert.equal(links.terminalFor("acp-1"), "term-a");

  // Attaching the same conversation elsewhere moves it rather than duplicating.
  links.link("term-b", "acp-1");
  assert.equal(links.acpFor("term-a"), undefined);
  assert.equal(links.acpFor("term-b"), "acp-1");

  // Re-attaching a terminal releases the conversation it used to show.
  links.link("term-b", "acp-2");
  assert.equal(links.terminalFor("acp-1"), undefined);
  assert.equal(links.unlinkTerminal("term-b"), "acp-2");
  assert.deepEqual(links.decorate(sessions), sessions);
});
