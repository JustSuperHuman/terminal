import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInputSnapshot } from "./terminal-manager.js";
import { TerminalPromptMonitor } from "./terminal-prompt-monitor.js";

const modes = {
  altScreen: true,
  bracketedPaste: true,
  applicationCursor: false,
  mouse: false
};

function snapshot(text: string): SessionInputSnapshot {
  return {
    session: {
      id: "term-bro",
      title: "Bro CLI",
      shell: "powershell.exe",
      args: [],
      cwd: "C:\\work",
      source: "bridged",
      status: "running",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      cols: 120,
      rows: 32,
      bufferedBytes: text.length
    },
    text,
    modes
  };
}

const question = [
  "Welcome to Claude Code",
  "Allow this command?",
  "❯ 1. Yes",
  "  2. No",
  "Enter to confirm · Esc to cancel"
].join("\n");

test("terminal prompt attention is edge-triggered by stable prompt identity", () => {
  let current = snapshot(question);
  const events: string[] = [];
  const monitor = new TerminalPromptMonitor(() => current, ({ context }) => events.push(context.prompt!.id));
  try {
    monitor.inspect("term-bro");
    monitor.inspect("term-bro");
    assert.equal(events.length, 1);

    // Focus-only redraws deliberately keep the same prompt id.
    current = snapshot(question.replace("❯ 1.", "  1.").replace("  2.", "❯ 2."));
    monitor.inspect("term-bro");
    assert.equal(events.length, 1);

    // Once the prompt clears, an identical future question is a new edge.
    current = snapshot("Welcome to Claude Code\n❯");
    monitor.inspect("term-bro");
    current = snapshot(question);
    monitor.inspect("term-bro");
    assert.equal(events.length, 2);
  } finally {
    monitor.dispose();
  }
});

test("shell menus are not reported as agent questions", () => {
  const picker = snapshot("Bro CLI\n❯ Claude subscription\n  Codex subscription\nEnter to confirm");
  let count = 0;
  const monitor = new TerminalPromptMonitor(() => picker, () => { count += 1; });
  try {
    monitor.inspect("term-bro");
    assert.equal(count, 0);
  } finally {
    monitor.dispose();
  }
});

test("bro runtime metadata makes a generic Claude question actionable", () => {
  const tagged = snapshot([
    "Choose a deployment target",
    "❯ 1. Staging",
    "  2. Production",
    "Enter to confirm · Esc to cancel"
  ].join("\n"));
  tagged.session.agent = "claude";
  tagged.session.agentSource = "osc";

  let contextAgent: string | undefined;
  const monitor = new TerminalPromptMonitor(() => tagged, ({ context }) => {
    contextAgent = context.agent;
  });
  try {
    monitor.inspect("term-bro");
    assert.equal(contextAgent, "claude");
  } finally {
    monitor.dispose();
  }
});
