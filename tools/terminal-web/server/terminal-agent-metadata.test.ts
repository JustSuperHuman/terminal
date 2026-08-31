import assert from "node:assert/strict";
import test from "node:test";
import {
  inferTerminalAgent,
  terminalAgentSummaryMetadata,
  TerminalAgentMetadataDetector,
  updateTerminalAgentObservation,
  updateTerminalAgentPresence,
  type MutableTerminalAgentMetadata,
  type TerminalAgentPresenceEvent
} from "./terminal-agent-metadata.js";

function envelope(
  value: Record<string, unknown>,
  terminator: "st" | "bel" = "st"
): string {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `\x1b]1337;TerminalWeb.Agent=${encoded}${terminator === "st" ? "\x1b\\" : "\x07"}`;
}

test("classifies named profiles and wrapped launch commands", () => {
  assert.equal(inferTerminalAgent("Codex Work", "pwsh.exe -NoLogo"), "codex");
  assert.equal(inferTerminalAgent("Agent", "pwsh.exe -Command \"claude --resume\""), "claude");
  assert.equal(inferTerminalAgent("Hermes", "C:\\Tools\\hermes.exe"), "hermes");
  assert.equal(inferTerminalAgent("PowerShell", "pwsh.exe -NoLogo"), undefined);
  assert.equal(inferTerminalAgent("Code explorer", "pwsh.exe ./codex-notes.ps1"), undefined);
});

test("runtime presence overrides and then restores launch metadata", () => {
  const metadata = {
    baseAgent: "hermes" as const,
    baseAgentSource: "profile" as const,
    runtimeAgent: undefined
  };

  assert.deepEqual(terminalAgentSummaryMetadata(metadata), { agent: "hermes", agentSource: "profile" });
  assert.equal(updateTerminalAgentPresence(metadata, { agent: "claude", state: "active" }), true);
  assert.deepEqual(terminalAgentSummaryMetadata(metadata), { agent: "claude", agentSource: "osc" });
  assert.equal(updateTerminalAgentPresence(metadata, { agent: "codex", state: "inactive" }), false);
  assert.deepEqual(terminalAgentSummaryMetadata(metadata), { agent: "claude", agentSource: "osc" });
  assert.equal(updateTerminalAgentPresence(metadata, { agent: "claude", state: "inactive" }), true);
  assert.deepEqual(terminalAgentSummaryMetadata(metadata), { agent: "hermes", agentSource: "profile" });
});

test("a hand-launched agent is recognised from the screen and released on exit", () => {
  const metadata: MutableTerminalAgentMetadata = {};

  // A plain shell tab: nothing to show until an agent actually starts.
  assert.deepEqual(terminalAgentSummaryMetadata(metadata), { agent: undefined, agentSource: undefined });

  assert.equal(updateTerminalAgentObservation(metadata, { agent: "claude", activity: "working" }), true);
  assert.deepEqual(terminalAgentSummaryMetadata(metadata), {
    agent: "claude",
    agentSource: "screen",
    agentActivity: "working"
  });

  // Repeating the same render must not churn the session list.
  assert.equal(updateTerminalAgentObservation(metadata, { agent: "claude", activity: "working" }), false);
  assert.equal(updateTerminalAgentObservation(metadata, { agent: "claude", activity: "awaiting" }), true);
  assert.deepEqual(terminalAgentSummaryMetadata(metadata), {
    agent: "claude",
    agentSource: "screen",
    agentActivity: "awaiting"
  });

  // Quitting back to the shell stops the terminal being an agent terminal.
  assert.equal(updateTerminalAgentObservation(metadata, {}), true);
  assert.deepEqual(terminalAgentSummaryMetadata(metadata), { agent: undefined, agentSource: undefined });
});

test("screen detection outranks the launch command but yields to the wrapper handshake", () => {
  const metadata: MutableTerminalAgentMetadata = {
    baseAgent: "claude",
    baseAgentSource: "command"
  };

  // A `claude` tab that has exited back to its shell is a shell, and a shell
  // that later ran `codex` is a codex terminal — the live screen decides.
  assert.deepEqual(terminalAgentSummaryMetadata(metadata), { agent: "claude", agentSource: "command" });
  updateTerminalAgentObservation(metadata, { agent: "codex", activity: "idle" });
  assert.deepEqual(terminalAgentSummaryMetadata(metadata), {
    agent: "codex",
    agentSource: "screen",
    agentActivity: "idle"
  });

  // The OSC handshake is a first-party statement of identity, so it still wins,
  // and its activity is dropped because the screen no longer describes it.
  updateTerminalAgentPresence(metadata, { agent: "claude", state: "active" });
  assert.deepEqual(terminalAgentSummaryMetadata(metadata), { agent: "claude", agentSource: "osc" });
});

test("decodes the exact bro presence envelope across arbitrary chunks", () => {
  const events: TerminalAgentPresenceEvent[] = [];
  const detector = new TerminalAgentMetadataDetector((event) => events.push(event));
  const active = envelope({ v: 1, agent: "claude", state: "active" });
  const inactive = envelope({ v: 1, agent: "claude", state: "inactive" });

  detector.feed("term-a", `before${active.slice(0, 9)}`);
  detector.feed("term-a", active.slice(9, -1));
  assert.deepEqual(events, []);
  detector.feed("term-a", active.slice(-1));
  detector.feed("term-a", active); // duplicate active handshakes are idempotent
  detector.feed("term-a", inactive);

  assert.deepEqual(events, [
    { sessionId: "term-a", agent: "claude", state: "active" },
    { sessionId: "term-a", agent: "claude", state: "inactive" }
  ]);
});

test("isolates terminals and ignores stale clears", () => {
  const events: TerminalAgentPresenceEvent[] = [];
  const detector = new TerminalAgentMetadataDetector((event) => events.push(event));

  detector.feed("one", envelope({ v: 1, agent: "claude", state: "active" }));
  detector.feed("two", envelope({ v: 1, agent: "codex", state: "active" }, "bel"));
  detector.feed("one", envelope({ v: 1, agent: "codex", state: "inactive" }));
  detector.feed("one", envelope({ v: 1, agent: "codex", state: "active" }));
  detector.feed("one", envelope({ v: 1, agent: "claude", state: "inactive" }));

  assert.deepEqual(events, [
    { sessionId: "one", agent: "claude", state: "active" },
    { sessionId: "two", agent: "codex", state: "active" },
    { sessionId: "one", agent: "codex", state: "active" }
  ]);
});

test("rejects malformed, oversized, extended, and unknown envelopes", () => {
  const events: TerminalAgentPresenceEvent[] = [];
  const detector = new TerminalAgentMetadataDetector((event) => events.push(event));
  const invalidFrames = [
    envelope({ v: 2, agent: "claude", state: "active" }),
    envelope({ v: 1, agent: "hermes", state: "active" }),
    envelope({ v: 1, agent: "codex", state: "busy" }),
    envelope({ v: 1, agent: "codex", state: "active", profile: "private" }),
    "\x1b]1337;TerminalWeb.Agent=not+base64url\x1b\\",
    `\x1b]1337;TerminalWeb.Agent=${"a".repeat(1100)}\x1b\\`,
    envelope({ v: 1, agent: "claude", state: "inactive" })
  ];

  detector.feed("term", invalidFrames.join(""));
  assert.deepEqual(events, []);
});

test("disposing a terminal drops parser and foreground state", () => {
  const events: TerminalAgentPresenceEvent[] = [];
  const detector = new TerminalAgentMetadataDetector((event) => events.push(event));
  const active = envelope({ v: 1, agent: "codex", state: "active" });
  const inactive = envelope({ v: 1, agent: "codex", state: "inactive" });

  detector.feed("term", active);
  detector.dispose("term");
  detector.feed("term", inactive);
  detector.feed("term", active);

  assert.deepEqual(events, [
    { sessionId: "term", agent: "codex", state: "active" },
    { sessionId: "term", agent: "codex", state: "active" }
  ]);
});
