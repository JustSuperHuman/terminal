import assert from "node:assert/strict";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import { AcpManager } from "./acp-manager.js";
import type { AcpAgentId, AcpAgentStatusView, AcpSessionView } from "./acp-types.js";

type ManagerValidation = {
  validateElicitationContent(schema: Record<string, unknown> | undefined, content: Record<string, unknown>): void;
};

type TestConnection = {
  agent: {
    request(method: unknown, params: unknown): Promise<unknown>;
  };
  close(error?: unknown): void;
};

type TestRuntime = {
  descriptor: { label: string };
  status: AcpAgentStatusView;
  connection?: TestConnection;
  generation: number;
};

type ManagerInternals = {
  agents: Map<AcpAgentId, TestRuntime>;
  sessions: Map<string, AcpSessionView>;
  promptTasks: Map<string, Promise<void>>;
  startPrompt(
    runtime: TestRuntime,
    session: AcpSessionView,
    prompt: acp.ContentBlock[],
    options: { reportFileChanges?: boolean },
    recordUser: boolean
  ): AcpSessionView;
  reconcileSessionsAfterReconnect(runtime: TestRuntime, generation: number): Promise<void>;
};

function internals(manager: AcpManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function session(overrides: Partial<AcpSessionView> = {}): AcpSessionView {
  const now = new Date().toISOString();
  return {
    id: "codex-local",
    agentSessionId: "remote-session",
    agent: "codex",
    title: "Codex test",
    cwd: process.cwd(),
    additionalDirectories: [],
    state: "error",
    createdAt: now,
    updatedAt: now,
    configOptions: [],
    availableCommands: [],
    plan: [],
    failures: [],
    fileChangeReports: [],
    timeline: [],
    terminals: [],
    subagents: [],
    ...overrides
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function validator(manager: AcpManager): ManagerValidation["validateElicitationContent"] {
  return (manager as unknown as ManagerValidation).validateElicitationContent.bind(manager);
}

test("ACP bridge publishes a stable JSON-safe initial snapshot", () => {
  const manager = new AcpManager();
  try {
    const state = manager.state();
    assert.equal(state.protocol.version, 1);
    assert.match(state.epoch, /^[0-9a-f-]{36}$/i);
    assert.equal(state.sequence, 0);
    assert.deepEqual(state.agents.map((agent) => agent.id), ["claude", "codex"]);
    assert.deepEqual(state.sessions, []);
    assert.deepEqual(state.requests, []);
    assert.ok(state.agents.every((agent) => typeof agent.capabilities.auth.logout === "boolean"));
  } finally {
    manager.dispose();
  }
});

test("elicitation validation enforces required values, constraints, and exact choices", () => {
  const manager = new AcpManager();
  const validate = validator(manager);
  const schema = {
    type: "object",
    required: ["name", "count", "targets"],
    properties: {
      name: { type: "string", minLength: 3, maxLength: 12, pattern: "^[A-Z]" },
      count: { type: "integer", minimum: 1, maximum: 4 },
      mode: { type: "string", oneOf: [{ const: "safe" }, { const: "fast" }] },
      targets: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: { type: "string", anyOf: [{ const: "mobile" }, { const: "desktop" }] }
      }
    }
  };

  try {
    assert.doesNotThrow(() => validate(schema, { name: "Agent", count: 2, mode: "safe", targets: ["mobile"] }));
    assert.throws(() => validate(schema, { count: 2, targets: ["mobile"] }), /name.*required/i);
    assert.throws(() => validate(schema, { name: "agent", count: 2, targets: ["mobile"] }), /required format/i);
    assert.throws(() => validate(schema, { name: "Agent", count: 5, targets: ["mobile"] }), /at most 4/i);
    assert.throws(() => validate(schema, { name: "Agent", count: 2, mode: "unsafe", targets: ["mobile"] }), /unavailable value/i);
    assert.throws(() => validate(schema, { name: "Agent", count: 2, targets: ["server"] }), /unavailable selection/i);
    assert.throws(() => validate(schema, { name: "Agent", count: 2, targets: ["mobile"], injected: true }), /not part of this request/i);
  } finally {
    manager.dispose();
  }
});

test("unknown form shapes use a bounded scalar fallback", () => {
  const manager = new AcpManager();
  const validate = validator(manager);
  try {
    assert.doesNotThrow(() => validate({ type: "future-form" }, { value: "answer" }));
    assert.throws(() => validate({ type: "future-form" }, { nested: { unsafe: true } }), /unsupported form shape/i);
  } finally {
    manager.dispose();
  }
});

test("late interactive responses fail closed", () => {
  const manager = new AcpManager();
  try {
    assert.throws(() => manager.respond("expired-request", { action: "cancel" }), /no longer active/i);
  } finally {
    manager.dispose();
  }
});

test("a prompt rejection from a disconnected adapter cannot restore the session to ready", async () => {
  const manager = new AcpManager();
  const state = internals(manager);
  const runtime = state.agents.get("codex")!;
  const pending = deferred<unknown>();
  const connection: TestConnection = {
    agent: { request: () => pending.promise },
    close: () => undefined
  };
  const active = session({ state: "ready" });

  try {
    runtime.generation = 7;
    runtime.connection = connection;
    runtime.status.state = "ready";
    state.sessions.set(active.id, active);

    state.startPrompt(runtime, active, [{ type: "text", text: "test" }], {}, true);
    const promptTask = state.promptTasks.get(active.id)!;
    assert.equal(active.state, "prompting");

    runtime.connection = undefined;
    runtime.status.state = "error";
    runtime.status.lastError = "Codex ACP adapter disconnected.";
    active.state = "error";
    active.error = runtime.status.lastError;
    pending.reject(new Error("RPC transport closed"));
    await promptTask;

    assert.equal(active.state, "error");
    assert.equal(active.error, "Codex ACP adapter disconnected.");
  } finally {
    manager.dispose();
  }
});

test("adapter reconnect resumes errored sessions and falls back to load", async () => {
  const manager = new AcpManager();
  const state = internals(manager);
  const runtime = state.agents.get("codex")!;
  const calls: string[] = [];
  const connection: TestConnection = {
    agent: {
      async request(method, params) {
        const remoteSessionId = (params as { sessionId: string }).sessionId;
        if (method === acp.methods.agent.session.resume) {
          calls.push(`resume:${remoteSessionId}`);
          if (remoteSessionId === "needs-load") throw new Error("resume unavailable for this session");
          return {};
        }
        if (method === acp.methods.agent.session.load) {
          calls.push(`load:${remoteSessionId}`);
          return {};
        }
        throw new Error("unexpected ACP method");
      }
    },
    close: () => undefined
  };
  const resumed = session({ id: "codex-resume", agentSessionId: "can-resume", error: "disconnected" });
  const loaded = session({ id: "codex-load", agentSessionId: "needs-load", error: "disconnected" });
  const untouched = session({ id: "codex-ready", agentSessionId: "already-ready", state: "ready" });

  try {
    runtime.generation = 11;
    runtime.connection = connection;
    runtime.status.state = "ready";
    runtime.status.capabilities.session.resume = true;
    runtime.status.capabilities.loadSession = true;
    state.sessions.set(resumed.id, resumed);
    state.sessions.set(loaded.id, loaded);
    state.sessions.set(untouched.id, untouched);

    await state.reconcileSessionsAfterReconnect(runtime, 11);

    assert.deepEqual(calls, ["resume:can-resume", "resume:needs-load", "load:needs-load"]);
    assert.equal(resumed.state, "ready");
    assert.equal(resumed.error, undefined);
    assert.equal(loaded.state, "ready");
    assert.equal(loaded.error, undefined);
    assert.equal(untouched.state, "ready");
    assert.equal(untouched.timeline.length, 0);
  } finally {
    manager.dispose();
  }
});
