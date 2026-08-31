import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { TransformStream } from "node:stream/web";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AcpAgentCapabilitiesView,
  AcpAgentId,
  AcpAgentStatusView,
  AcpAvailableCommandView,
  AcpBridgeState,
  AcpConfigOptionView,
  AcpContentView,
  AcpFileChangeReportView,
  AcpGoalView,
  AcpInteractiveRequestView,
  AcpModeStateView,
  AcpPermissionOptionView,
  AcpPlanEntryView,
  AcpPromptBlockInput,
  AcpSessionFailureView,
  AcpSessionView,
  AcpSubagentView,
  AcpTerminalView,
  AcpTimelineItemView,
  AcpToolCallView,
  AcpToolContentView,
  AcpUsageView
} from "./acp-types.js";

const SDK_VERSION = "1.4.0";
const CLIENT_VERSION = "0.1.0";
const MAX_TIMELINE_ITEMS = 600;
const MAX_SUBAGENT_TIMELINE_ITEMS = 240;
const MAX_TEXT_CHARS = 160_000;
const MAX_DIFF_CHARS = 160_000;
const MAX_PROMPT_BLOCKS = 24;
const MAX_PROMPT_TEXT_CHARS = 320_000;
const MAX_PROMPT_BINARY_BYTES = 12 * 1024 * 1024;
const DEFAULT_TERMINAL_BYTES = 1024 * 1024;
const MAX_TERMINAL_BYTES = 4 * 1024 * 1024;
const SESSION_BROADCAST_MS = 40;
const AIR_CAPABILITIES = ["sessionFailure", "agentFileChangeReport", "nativeSubagentSessions"];
const KNOWN_SESSION_UPDATES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "compaction_update",
  "compaction_summary_chunk"
]);

interface AdapterDescriptor {
  packageName: string;
  binaryName: string;
  label: string;
  version: string;
  entrypoint?: string;
}

interface AgentRuntime {
  descriptor: AdapterDescriptor;
  status: AcpAgentStatusView;
  process?: ChildProcessWithoutNullStreams;
  connection?: acp.ClientConnection;
  initialize?: acp.InitializeResponse;
  startPromise?: Promise<AcpAgentStatusView>;
  generation: number;
  intentionalStop: boolean;
  steeringMethod?: string;
  goalControlMethod?: string;
  goalActions: string[];
  authMethods: Map<string, acp.AuthMethod>;
}

export interface AcpTerminalAuthLaunch {
  agent: AcpAgentId;
  title: string;
  shell: string;
  args: string[];
  env: Record<string, string>;
}

interface PendingPermission {
  kind: "permission";
  view: AcpInteractiveRequestView;
  remoteSessionId: string;
  resolve: (response: acp.RequestPermissionResponse) => void;
}

interface PendingElicitation {
  kind: "elicitation";
  view: AcpInteractiveRequestView;
  remoteSessionId?: string;
  elicitationId?: string;
  schema?: Record<string, unknown>;
  resolve: (response: acp.CreateElicitationResponse) => void;
}

type PendingInteractive = PendingPermission | PendingElicitation;

interface RuntimeTerminal {
  view: AcpTerminalView;
  remoteSessionId: string;
  child: ChildProcessWithoutNullStreams;
  byteLimit: number;
  exitPromise: Promise<{ exitCode?: number; signal?: string }>;
  resolveExit: (value: { exitCode?: number; signal?: string }) => void;
}

interface SubagentLink {
  rootSessionId: string;
  subagentId: string;
}

type SessionUpdateRecord = Record<string, unknown> & { sessionUpdate: string };

const nodeRequire = createRequire(import.meta.url);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, max = MAX_TEXT_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… [truncated]`;
}

function isHighRiskAccessSetting(...values: Array<string | undefined>): boolean {
  return values.some((value) => /full[\s_-]*access|bypass[\s_-]*permissions?|unrestricted access/i.test(value ?? ""));
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return truncate(
    raw
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
      .replace(/([?&](?:token|key|secret|code)=)[^&\s]+/gi, "$1[redacted]")
      .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]"),
    600
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyCapabilities(): AcpAgentCapabilitiesView {
  return {
    loadSession: false,
    auth: { logout: false },
    prompt: { image: false, audio: false, embeddedContext: false },
    session: {
      list: false,
      delete: false,
      fork: false,
      resume: false,
      close: false,
      additionalDirectories: false
    },
    mcp: { acp: false, http: false, sse: false },
    steering: false,
    goal: { supported: false, actions: [] },
    sessionFailures: false,
    fileChangeReports: false,
    nativeSubagents: false,
    extensions: []
  };
}

function resolveAdapter(agent: AcpAgentId): AdapterDescriptor {
  const packageName =
    agent === "claude"
      ? "@agentclientprotocol/claude-agent-acp"
      : "@agentclientprotocol/codex-acp";
  const binaryName = agent === "claude" ? "claude-agent-acp" : "codex-acp";
  const label = agent === "claude" ? "Claude" : "Codex";

  try {
    const packagePath = nodeRequire.resolve(`${packageName}/package.json`);
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
      version?: string;
      bin?: string | Record<string, string>;
    };
    const relativeBin =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binaryName];
    const entrypoint = relativeBin ? path.resolve(path.dirname(packagePath), relativeBin) : undefined;
    return {
      packageName,
      binaryName,
      label,
      version: manifest.version ?? "unknown",
      entrypoint: entrypoint && existsSync(entrypoint) ? entrypoint : undefined
    };
  } catch {
    return { packageName, binaryName, label, version: "not installed" };
  }
}

function agentKey(agent: AcpAgentId, remoteSessionId: string): string {
  return `${agent}\0${remoteSessionId}`;
}

function publicSessionId(agent: AcpAgentId, remoteSessionId: string): string {
  return `${agent}-${Buffer.from(remoteSessionId, "utf8").toString("base64url")}`;
}

function normalizeImplementation(value: acp.Implementation | null | undefined) {
  if (!value) return undefined;
  return {
    name: value.name,
    ...(value.title ? { title: value.title } : {}),
    ...(value.version ? { version: value.version } : {})
  };
}

function normalizeCapabilities(response: acp.InitializeResponse): AcpAgentCapabilitiesView {
  const capabilities = response.agentCapabilities;
  const session = capabilities?.sessionCapabilities;
  const prompt = capabilities?.promptCapabilities;
  const mcp = capabilities?.mcpCapabilities;
  const mcpRecord = asRecord(mcp);
  const mcpAcp = mcpRecord?.acp;
  const meta = asRecord(response._meta);
  const goal = asRecord(meta?.goal);
  const air = asRecord(asRecord(asRecord(meta?.jetbrains)?.air));
  const advertisedAir = Array.isArray(air?.capabilities)
    ? air.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  const steering = asRecord(meta?.steering)?.supported === true;
  const goalActions = Array.isArray(goal?.actions)
    ? goal.actions.filter((item): item is string => typeof item === "string")
    : [];
  const extensionNames = [
    ...(steering ? ["steering"] : []),
    ...(typeof goal?.controlMethod === "string" ? ["goal"] : []),
    ...advertisedAir
  ];

  return {
    loadSession: capabilities?.loadSession === true,
    auth: { logout: capabilities?.auth?.logout != null },
    prompt: {
      image: prompt?.image === true,
      audio: prompt?.audio === true,
      embeddedContext: prompt?.embeddedContext === true
    },
    session: {
      list: session?.list != null,
      delete: session?.delete != null,
      fork: session?.fork != null,
      resume: session?.resume != null,
      close: session?.close != null,
      additionalDirectories: session?.additionalDirectories != null
    },
    mcp: {
      acp: mcpAcp === true || asRecord(mcpAcp) != null,
      http: mcp?.http === true,
      sse: mcp?.sse === true
    },
    steering,
    goal: { supported: typeof goal?.controlMethod === "string", actions: goalActions },
    sessionFailures: advertisedAir.includes("sessionFailure"),
    fileChangeReports: advertisedAir.includes("agentFileChangeReport"),
    nativeSubagents: advertisedAir.includes("nativeSubagentSessions"),
    extensions: [...new Set(extensionNames)]
  };
}

function normalizeModes(value: acp.SessionModeState | null | undefined): AcpModeStateView | undefined {
  if (!value) return undefined;
  return {
    currentModeId: value.currentModeId,
    availableModes: value.availableModes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {})
    }))
  };
}

function normalizeConfigOptions(values: acp.SessionConfigOption[] | null | undefined): AcpConfigOptionView[] {
  return (values ?? []).map((option) => {
    const common = {
      id: option.id,
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
      ...(option.category ? { category: option.category } : {})
    };
    if (option.type === "boolean") {
      return { ...common, type: "boolean" as const, currentValue: option.currentValue };
    }
    const flattened = option.options.flatMap((candidate) => {
      if ("options" in candidate) {
        return candidate.options.map((item) => ({
          value: item.value,
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
          group: candidate.group,
          groupName: candidate.name
        }));
      }
      return [{
        value: candidate.value,
        name: candidate.name,
        ...(candidate.description ? { description: candidate.description } : {})
      }];
    });
    return { ...common, type: "select" as const, currentValue: option.currentValue, options: flattened };
  });
}

function normalizePlan(entries: acp.PlanEntry[] | undefined): AcpPlanEntryView[] {
  return (entries ?? []).map((entry) => ({
    content: entry.content,
    priority: entry.priority,
    status: entry.status
  }));
}

function normalizeUsage(value: unknown): AcpUsageView | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const cost = asRecord(usage.cost);
  const normalized: AcpUsageView = {
    ...(optionalNumber(usage.used) !== undefined ? { used: optionalNumber(usage.used) } : {}),
    ...(optionalNumber(usage.size) !== undefined ? { size: optionalNumber(usage.size) } : {}),
    ...(optionalNumber(usage.totalTokens) !== undefined ? { totalTokens: optionalNumber(usage.totalTokens) } : {}),
    ...(optionalNumber(usage.inputTokens) !== undefined ? { inputTokens: optionalNumber(usage.inputTokens) } : {}),
    ...(optionalNumber(usage.outputTokens) !== undefined ? { outputTokens: optionalNumber(usage.outputTokens) } : {}),
    ...(optionalNumber(usage.thoughtTokens) !== undefined ? { thoughtTokens: optionalNumber(usage.thoughtTokens) } : {}),
    ...(optionalNumber(usage.cachedReadTokens) !== undefined ? { cachedReadTokens: optionalNumber(usage.cachedReadTokens) } : {}),
    ...(optionalNumber(usage.cachedWriteTokens) !== undefined ? { cachedWriteTokens: optionalNumber(usage.cachedWriteTokens) } : {})
  };
  if (typeof cost?.amount === "number" && typeof cost.currency === "string") {
    normalized.cost = { amount: cost.amount, currency: cost.currency };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeContent(block: acp.ContentBlock): AcpContentView {
  switch (block.type) {
    case "text":
      return { type: "text", text: truncate(block.text) };
    case "image":
      return {
        type: "image",
        mimeType: block.mimeType,
        ...(block.data.length <= 350_000 ? { data: block.data } : {}),
        ...(block.uri ? { uri: block.uri } : {})
      };
    case "audio":
      return {
        type: "audio",
        mimeType: block.mimeType,
        ...(block.data.length <= 350_000 ? { data: block.data } : {})
      };
    case "resource_link":
      return {
        type: "resource",
        uri: block.uri,
        name: block.name,
        ...(block.title ? { title: block.title } : {}),
        ...(block.mimeType ? { mimeType: block.mimeType } : {})
      };
    case "resource": {
      const resource = block.resource;
      return {
        type: "resource",
        uri: resource.uri,
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        ...("text" in resource ? { text: truncate(resource.text) } : {})
      };
    }
  }
}

function safeJson(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncate(value, 24_000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeJson(item, depth + 1));
  const record = asRecord(value);
  if (!record) return String(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record).slice(0, 100)) {
    result[key] = /token|secret|password|authorization|cookie|api[_-]?key/i.test(key)
      ? "[redacted]"
      : safeJson(item, depth + 1);
  }
  return result;
}

function normalizeToolContent(content: acp.ToolCallContent[] | null | undefined): AcpToolContentView[] {
  return (content ?? []).map((item) => {
    if (item.type === "content") return { type: "content", content: normalizeContent(item.content) };
    if (item.type === "terminal") return { type: "terminal", terminalId: item.terminalId };
    const oldText = item.oldText ?? undefined;
    const truncatedOld = oldText ? truncate(oldText, MAX_DIFF_CHARS) : undefined;
    const truncatedNew = truncate(item.newText, MAX_DIFF_CHARS);
    return {
      type: "diff",
      path: item.path,
      ...(truncatedOld !== undefined ? { oldText: truncatedOld } : {}),
      newText: truncatedNew,
      ...((oldText?.length ?? 0) > MAX_DIFF_CHARS || item.newText.length > MAX_DIFF_CHARS
        ? { truncated: true }
        : {})
    };
  });
}

function normalizeToolCall(
  value: (Partial<acp.ToolCall> | acp.ToolCallUpdate) & { toolCallId: string }
): AcpToolCallView {
  return {
    toolCallId: value.toolCallId,
    title: value.title ?? "Tool call",
    ...(value.name ? { name: value.name } : {}),
    kind: value.kind ?? "other",
    status: value.status ?? "pending",
    content: normalizeToolContent(value.content),
    locations: (value.locations ?? []).map((location) => ({
      path: location.path,
      ...(location.line != null ? { line: location.line } : {})
    })),
    ...(value.rawInput !== undefined ? { rawInput: safeJson(value.rawInput) } : {}),
    ...(value.rawOutput !== undefined ? { rawOutput: safeJson(value.rawOutput) } : {})
  };
}

function adapterStream(
  child: ChildProcessWithoutNullStreams
): { stream: acp.Stream; onUnknownUpdate: (handler: (update: SessionUpdateRecord) => void) => void } {
  const raw = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
  );
  let unknownHandler: (update: SessionUpdateRecord) => void = () => undefined;
  const transform = new TransformStream<acp.AnyMessage | undefined, acp.AnyMessage>({
    transform(message, controller) {
      if (!message) return;
      const record = asRecord(message);
      const params = asRecord(record?.params);
      const update = asRecord(params?.update);
      const kind = optionalString(update?.sessionUpdate);
      if (update && record?.method === acp.methods.client.session.update && kind && !KNOWN_SESSION_UPDATES.has(kind)) {
        const original = clone(update) as SessionUpdateRecord;
        unknownHandler(original);
        controller.enqueue({
          ...record,
          params: {
            ...params,
            update: {
              sessionUpdate: "session_info_update",
              _meta: {
                ...(asRecord(update._meta) ?? {}),
                terminalWeb: { originalSessionUpdate: original }
              }
            }
          }
        } as acp.AnyMessage);
        return;
      }
      controller.enqueue(message);
    }
  });
  // `@types/node` and the SDK currently name two structurally compatible Web
  // Streams interfaces. Keep that packaging mismatch at this single boundary.
  const readable = (raw.readable as unknown as {
    pipeThrough(transformer: unknown): acp.Stream["readable"];
  }).pipeThrough(transform);
  return {
    stream: { writable: raw.writable, readable },
    onUnknownUpdate(handler) {
      unknownHandler = handler;
    }
  };
}

export class AcpManager extends EventEmitter {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private readonly agents = new Map<AcpAgentId, AgentRuntime>();
  private readonly sessions = new Map<string, AcpSessionView>();
  private readonly remoteSessions = new Map<string, string>();
  private readonly pending = new Map<string, PendingInteractive>();
  private readonly terminals = new Map<string, RuntimeTerminal>();
  private readonly subagentLinks = new Map<string, SubagentLink>();
  private readonly promptTasks = new Map<string, Promise<void>>();
  private readonly broadcastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private terminalAuthHandler?: (launch: AcpTerminalAuthLaunch) => Promise<void>;

  constructor() {
    super();
    for (const id of ["claude", "codex"] as const) {
      const descriptor = resolveAdapter(id);
      this.agents.set(id, {
        descriptor,
        generation: 0,
        intentionalStop: false,
        goalActions: [],
        authMethods: new Map(),
        status: {
          id,
          label: descriptor.label,
          state: "stopped",
          available: Boolean(descriptor.entrypoint),
          adapterVersion: descriptor.version,
          capabilities: emptyCapabilities(),
          authMethods: [],
          availableSessions: [],
          ...(!descriptor.entrypoint
            ? { lastError: `${descriptor.packageName} is not installed. Run bun install in tools/terminal-web.` }
            : {})
        }
      });
    }
  }

  setTerminalAuthHandler(handler: (launch: AcpTerminalAuthLaunch) => Promise<void>): void {
    this.terminalAuthHandler = handler;
  }

  state(): AcpBridgeState {
    return {
      epoch: this.epoch,
      sequence: this.sequence,
      protocol: { version: 1, sdkVersion: SDK_VERSION },
      agents: [...this.agents.values()].map((runtime) => clone(runtime.status)),
      sessions: [...this.sessions.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(clone),
      requests: [...this.pending.values()]
        .map((item) => clone(item.view))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    };
  }

  session(id: string): AcpSessionView | undefined {
    const session = this.sessions.get(id);
    return session ? clone(session) : undefined;
  }

  async startAgent(agent: AcpAgentId): Promise<AcpAgentStatusView> {
    const runtime = this.requireAgent(agent);
    if (runtime.status.state === "ready" && runtime.connection) return clone(runtime.status);
    if (runtime.startPromise) return runtime.startPromise;
    if (!runtime.descriptor.entrypoint) throw new Error(runtime.status.lastError ?? "ACP adapter is unavailable.");

    runtime.startPromise = this.connectAgent(runtime).finally(() => {
      runtime.startPromise = undefined;
    });
    return runtime.startPromise;
  }

  async stopAgent(agent: AcpAgentId): Promise<AcpAgentStatusView> {
    const runtime = this.requireAgent(agent);
    runtime.intentionalStop = true;
    this.cancelPendingForAgent(agent);
    runtime.connection?.close();
    runtime.process?.kill();
    runtime.connection = undefined;
    runtime.process = undefined;
    runtime.initialize = undefined;
    runtime.status = {
      ...runtime.status,
      state: "stopped",
      protocolVersion: undefined,
      implementation: undefined,
      capabilities: emptyCapabilities(),
      authMethods: [],
      availableSessions: [],
      lastError: undefined
    };
    for (const session of this.sessions.values()) {
      if (session.agent === agent && session.state !== "closed") {
        session.state = "error";
        session.error = `${runtime.descriptor.label} ACP adapter stopped.`;
        this.markSession(session, true);
      }
    }
    this.emitState();
    return clone(runtime.status);
  }

  async authenticate(agent: AcpAgentId, methodId: string): Promise<AcpAgentStatusView> {
    const runtime = await this.readyRuntime(agent);
    const method = runtime.status.authMethods.find((candidate) => candidate.id === methodId);
    if (!method) throw new Error("Unknown authentication method.");
    if (method.type === "terminal") {
      const wireMethod = runtime.authMethods.get(methodId);
      if (!wireMethod || !("type" in wireMethod) || wireMethod.type !== "terminal" || !this.terminalAuthHandler) {
        throw new Error("Terminal authentication is unavailable on this host.");
      }
      await this.terminalAuthHandler({
        agent,
        title: `${runtime.descriptor.label} sign in`,
        shell: process.execPath,
        args: [runtime.descriptor.entrypoint!, ...(wireMethod.args ?? [])],
        env: wireMethod.env ?? {}
      });
      await this.stopAgent(agent);
      return this.startAgent(agent);
    }
    await runtime.connection!.agent.request(acp.methods.agent.authenticate, { methodId });
    await this.refreshRemoteSessions(runtime).catch(() => undefined);
    this.emitState();
    return clone(runtime.status);
  }

  async logout(agent: AcpAgentId): Promise<AcpAgentStatusView> {
    const runtime = await this.readyRuntime(agent);
    if (!runtime.status.capabilities.auth.logout) throw new Error(`${runtime.descriptor.label} does not advertise logout.`);
    await runtime.connection!.agent.request(acp.methods.agent.logout, {});
    // Authentication methods are negotiated during initialize. Reconnect so
    // the UI immediately receives the now-applicable login methods instead of
    // showing the pre-logout catalog.
    await this.stopAgent(agent);
    return this.startAgent(agent);
  }

  async refreshSessions(agent: AcpAgentId): Promise<AcpAgentStatusView> {
    const runtime = await this.readyRuntime(agent);
    await this.refreshRemoteSessions(runtime);
    this.emitState();
    return clone(runtime.status);
  }

  async createSession(input: {
    agent: AcpAgentId;
    cwd: string;
    additionalDirectories?: string[];
    mcpServers?: acp.McpServer[];
  }): Promise<AcpSessionView> {
    const runtime = await this.readyRuntime(input.agent);
    const cwd = await this.workspaceDirectory(input.cwd);
    const additionalDirectories = await this.additionalDirectories(runtime, input.additionalDirectories ?? []);
    const result = await runtime.connection!.agent.request(acp.methods.agent.session.new, {
      cwd,
      additionalDirectories,
      mcpServers: input.mcpServers ?? []
    });
    const session = this.newSessionView(runtime, result.sessionId, cwd, additionalDirectories, {
      modes: result.modes,
      configOptions: result.configOptions
    });
    this.putSession(session);
    await this.refreshRemoteSessions(runtime).catch(() => undefined);
    return clone(session);
  }

  async loadSession(input: {
    agent: AcpAgentId;
    sessionId: string;
    cwd: string;
    mode?: "load" | "resume";
    additionalDirectories?: string[];
    mcpServers?: acp.McpServer[];
  }): Promise<AcpSessionView> {
    const runtime = await this.readyRuntime(input.agent);
    if (input.mode === "resume" && !runtime.status.capabilities.session.resume) {
      throw new Error(`${runtime.descriptor.label} does not advertise session resume.`);
    }
    if (input.mode !== "resume" && !runtime.status.capabilities.loadSession) {
      throw new Error(`${runtime.descriptor.label} does not advertise session history loading.`);
    }
    const existing = this.sessionForRemote(input.agent, input.sessionId);
    if (existing && existing.state !== "closed" && existing.state !== "error") return clone(existing);
    const cwd = await this.workspaceDirectory(input.cwd);
    const additionalDirectories = await this.additionalDirectories(runtime, input.additionalDirectories ?? []);
    const session = this.newSessionView(runtime, input.sessionId, cwd, additionalDirectories);
    session.state = "connecting";
    this.putSession(session);

    try {
      const request = {
        sessionId: input.sessionId,
        cwd,
        additionalDirectories,
        mcpServers: input.mcpServers ?? []
      };
      const response = input.mode === "resume"
        ? await runtime.connection!.agent.request(acp.methods.agent.session.resume, request)
        : await runtime.connection!.agent.request(acp.methods.agent.session.load, request);
      const record = asRecord(response);
      session.modes = normalizeModes(record?.modes as acp.SessionModeState | null | undefined);
      session.configOptions = normalizeConfigOptions(record?.configOptions as acp.SessionConfigOption[] | null | undefined);
      session.state = "ready";
      session.error = undefined;
      this.appendStatus(session, input.mode === "resume" ? "Session resumed" : "Session history loaded");
      this.markSession(session, true);
      return clone(session);
    } catch (error) {
      session.state = "error";
      session.error = safeError(error);
      this.appendError(session, session.error);
      this.markSession(session, true);
      throw error;
    }
  }

  async forkSession(id: string, cwd?: string): Promise<AcpSessionView> {
    const source = this.requireSession(id);
    const runtime = await this.readyRuntime(source.agent);
    if (!runtime.status.capabilities.session.fork) throw new Error("This agent does not support session forks.");
    const nextCwd = await this.workspaceDirectory(cwd ?? source.cwd);
    const result = await runtime.connection!.agent.request(acp.methods.agent.session.fork, {
      sessionId: source.agentSessionId,
      cwd: nextCwd,
      additionalDirectories: source.additionalDirectories,
      mcpServers: []
    });
    const session = this.newSessionView(runtime, result.sessionId, nextCwd, source.additionalDirectories, {
      modes: result.modes,
      configOptions: result.configOptions
    });
    this.appendStatus(session, `Forked from ${source.title}`);
    this.putSession(session);
    return clone(session);
  }

  async closeSession(id: string, deleteRemote = false): Promise<void> {
    const session = this.requireSession(id);
    const runtime = await this.readyRuntime(session.agent);
    await this.cancelSession(id).catch(() => undefined);
    if (deleteRemote && runtime.status.capabilities.session.delete) {
      await runtime.connection!.agent.request(acp.methods.agent.session.delete, { sessionId: session.agentSessionId });
    } else if (runtime.status.capabilities.session.close) {
      await runtime.connection!.agent.request(acp.methods.agent.session.close, { sessionId: session.agentSessionId });
    }
    this.releaseSessionTerminals(session);
    session.state = "closed";
    session.updatedAt = new Date().toISOString();
    this.sessions.delete(id);
    this.remoteSessions.delete(agentKey(session.agent, session.agentSessionId));
    this.sequence += 1;
    this.emit("session_removed", { epoch: this.epoch, sequence: this.sequence, sessionId: id });
    this.emitState();
    await this.refreshRemoteSessions(runtime).catch(() => undefined);
  }

  async promptSession(
    id: string,
    blocks: AcpPromptBlockInput[],
    options: { reportFileChanges?: boolean } = {}
  ): Promise<AcpSessionView> {
    const session = this.requireSession(id);
    const runtime = await this.readyRuntime(session.agent);
    const prompt = this.protocolPrompt(runtime, blocks);
    if (prompt.length === 0) throw new Error("Prompt content is empty.");

    if (session.state === "prompting" || session.state === "cancelling") {
      if (!runtime.status.capabilities.steering || !runtime.steeringMethod) {
        throw new Error("The agent is already working and does not advertise steering.");
      }
      this.recordUserPrompt(session, prompt, "Steering");
      const response = await runtime.connection!.agent.request<Record<string, unknown>, Record<string, unknown>>(
        runtime.steeringMethod,
        {
          sessionId: session.agentSessionId,
          prompt,
          _meta: { steering: { idleBehavior: "promptRequired" } }
        }
      );
      if (response.outcome === "promptRequired") {
        return this.startPrompt(runtime, session, prompt, options, false);
      }
      this.appendStatus(session, response.outcome === "injected" ? "Follow-up injected" : "Follow-up started");
      this.markSession(session, true);
      return clone(session);
    }

    return this.startPrompt(runtime, session, prompt, options, true);
  }

  async cancelSession(id: string): Promise<AcpSessionView> {
    const session = this.requireSession(id);
    const runtime = await this.readyRuntime(session.agent);
    if (session.state !== "prompting" && session.state !== "cancelling") return clone(session);
    session.state = "cancelling";
    this.cancelPendingForSession(session);
    await runtime.connection!.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.agentSessionId });
    this.appendStatus(session, "Cancellation requested");
    this.markSession(session, true);
    return clone(session);
  }

  async setMode(id: string, modeId: string, confirmDangerous = false): Promise<AcpSessionView> {
    const session = this.requireSession(id);
    const runtime = await this.readyRuntime(session.agent);
    const mode = session.modes?.availableModes.find((candidate) => candidate.id === modeId);
    if (!mode) throw new Error("Unknown session mode.");
    if (isHighRiskAccessSetting(mode.id, mode.name, mode.description) && !confirmDangerous) {
      throw new Error("Confirmation is required before enabling unrestricted agent access.");
    }
    await runtime.connection!.agent.request(acp.methods.agent.session.setMode, {
      sessionId: session.agentSessionId,
      modeId
    });
    session.modes!.currentModeId = modeId;
    this.markSession(session, true);
    return clone(session);
  }

  async setConfig(id: string, configId: string, value: string | boolean, confirmDangerous = false): Promise<AcpSessionView> {
    const session = this.requireSession(id);
    const runtime = await this.readyRuntime(session.agent);
    const option = session.configOptions.find((candidate) => candidate.id === configId);
    if (!option) throw new Error("Unknown session configuration option.");
    if (option.type === "boolean" && typeof value !== "boolean") throw new Error("This configuration expects a boolean.");
    if (option.type === "select" && (typeof value !== "string" || !option.options.some((item) => item.value === value))) {
      throw new Error("This configuration value is not available.");
    }
    if (option.type === "select" && typeof value === "string") {
      const selected = option.options.find((item) => item.value === value);
      const controlsAccess = option.category === "mode" || option.id.toLowerCase() === "mode";
      if (controlsAccess && isHighRiskAccessSetting(value, selected?.name, selected?.description) && !confirmDangerous) {
        throw new Error("Confirmation is required before enabling unrestricted agent access.");
      }
    }
    const request = option.type === "boolean"
      ? { sessionId: session.agentSessionId, configId, type: "boolean" as const, value: value as boolean }
      : { sessionId: session.agentSessionId, configId, value: value as string };
    const response = await runtime.connection!.agent.request(
      acp.methods.agent.session.setConfigOption,
      request
    ) as acp.SetSessionConfigOptionResponse;
    session.configOptions = normalizeConfigOptions(response.configOptions);
    this.markSession(session, true);
    return clone(session);
  }

  async controlGoal(id: string, action: string, objective?: string): Promise<AcpSessionView> {
    const session = this.requireSession(id);
    const runtime = await this.readyRuntime(session.agent);
    if (!runtime.goalControlMethod || !runtime.goalActions.includes(action)) throw new Error("This goal action is not supported.");
    if (action === "set" && !optionalString(objective)) throw new Error("A goal objective is required.");
    await runtime.connection!.agent.request<Record<string, unknown>, Record<string, unknown>>(
      runtime.goalControlMethod,
      {
        sessionId: session.agentSessionId,
        action,
        ...(action === "set" ? { objective: objective!.trim() } : {})
      }
    );
    return clone(session);
  }

  respond(requestId: string, response: { action?: string; optionId?: string; content?: Record<string, unknown> }): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error("This request is no longer active.");
    this.pending.delete(requestId);
    if (pending.kind === "permission") {
      if (response.action === "select") {
        const optionId = optionalString(response.optionId);
        if (!optionId || !pending.view.options?.some((option) => option.optionId === optionId)) {
          this.pending.set(requestId, pending);
          throw new Error("Select one of the permission options supplied by the agent.");
        }
        pending.resolve({ outcome: { outcome: "selected", optionId } });
      } else if (response.action === "cancel") {
        pending.resolve({ outcome: { outcome: "cancelled" } });
      } else {
        this.pending.set(requestId, pending);
        throw new Error("Permission responses must select an option or cancel.");
      }
    } else {
      const action = response.action;
      if (action === "accept") {
        const content = response.content ?? {};
        this.validateElicitationContent(pending.schema, content);
        pending.resolve({ action: "accept", content: content as Record<string, acp.ElicitationContentValue> });
      } else if (action === "decline" || action === "cancel") {
        pending.resolve({ action });
      } else {
        this.pending.set(requestId, pending);
        throw new Error("Elicitation responses must accept, decline, or cancel.");
      }
    }
    this.emitState();
  }

  dispose(): void {
    for (const timer of this.broadcastTimers.values()) clearTimeout(timer);
    this.broadcastTimers.clear();
    for (const id of this.agents.keys()) void this.stopAgent(id);
    for (const terminal of this.terminals.values()) terminal.child.kill();
  }

  private async connectAgent(runtime: AgentRuntime): Promise<AcpAgentStatusView> {
    const agent = runtime.status.id;
    const generation = ++runtime.generation;
    runtime.intentionalStop = false;
    runtime.status = {
      ...runtime.status,
      state: "starting",
      lastError: undefined,
      protocolVersion: undefined,
      implementation: undefined,
      capabilities: emptyCapabilities(),
      authMethods: [],
      availableSessions: []
    };
    this.emitState();

    const child = spawn(process.execPath, [runtime.descriptor.entrypoint!], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    runtime.process = child;
    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = truncate(`${stderrTail}${chunk}`, 8_000);
    });

    const transport = adapterStream(child);
    const client = acp
      .client({ name: "windows-terminal-mobile-bridge" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.requestPermission(agent, ctx.params, ctx.signal))
      .onNotification(acp.methods.client.session.update, (ctx) => this.handleSessionUpdate(agent, ctx.params))
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => this.readTextFile(agent, ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => this.writeTextFile(agent, ctx.params))
      .onRequest(acp.methods.client.terminal.create, (ctx) => this.createTerminal(agent, ctx.params))
      .onRequest(acp.methods.client.terminal.output, (ctx) => this.terminalOutput(ctx.params))
      .onRequest(acp.methods.client.terminal.waitForExit, (ctx) => this.waitForTerminal(ctx.params))
      .onRequest(acp.methods.client.terminal.kill, (ctx) => this.killTerminal(ctx.params))
      .onRequest(acp.methods.client.terminal.release, (ctx) => this.releaseTerminal(ctx.params))
      .onRequest(acp.methods.client.elicitation.create, (ctx) => this.requestElicitation(agent, ctx.params, ctx.signal))
      .onNotification(acp.methods.client.elicitation.complete, (ctx) => this.completeElicitation(agent, ctx.params));

    const connection = client.connect(transport.stream);
    runtime.connection = connection;
    transport.onUnknownUpdate(() => undefined);
    connection.closed.then(() => {
      if (runtime.generation !== generation) return;
      const intentional = runtime.intentionalStop;
      runtime.connection = undefined;
      runtime.process = undefined;
      runtime.initialize = undefined;
      if (!intentional) {
        runtime.status.state = "error";
        runtime.status.lastError = stderrTail.trim()
          ? safeError(stderrTail.trim().split(/\r?\n/).at(-1))
          : `${runtime.descriptor.label} ACP adapter disconnected.`;
        this.cancelPendingForAgent(agent);
        for (const session of this.sessions.values()) {
          if (session.agent === agent && session.state !== "closed") {
            session.state = "error";
            session.error = runtime.status.lastError;
            this.markSession(session, true);
          }
        }
        this.emitState();
      }
    }).catch(() => undefined);

    try {
      const clientCapabilities = {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        session: { configOptions: { boolean: {} }, compaction: {} },
        plan: {},
        auth: { terminal: Boolean(this.terminalAuthHandler) },
        elicitation: { form: {}, url: {} },
        subagents: {},
        _meta: {
          terminal_output: true,
          // Claude 0.70 still uses this legacy capability to forward nested
          // agent text when native child-session updates are unavailable.
          "subagent-transcript": true,
          jetbrains: { air: { version: 1, capabilities: AIR_CAPABILITIES } }
        }
      } as acp.ClientCapabilities;
      const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities,
        clientInfo: {
          name: "terminal-web",
          title: "Windows Terminal Mobile Bridge",
          version: CLIENT_VERSION
        }
      });
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new Error(`Unsupported ACP protocol version ${initialized.protocolVersion}.`);
      }
      runtime.initialize = initialized;
      runtime.authMethods = new Map((initialized.authMethods ?? []).map((method) => [method.id, method]));
      const meta = asRecord(initialized._meta);
      const steering = asRecord(meta?.steering);
      const goal = asRecord(meta?.goal);
      runtime.steeringMethod = steering?.supported === true ? "_session/steering" : undefined;
      runtime.goalControlMethod = optionalString(goal?.controlMethod);
      runtime.goalActions = Array.isArray(goal?.actions)
        ? goal.actions.filter((item): item is string => typeof item === "string")
        : [];
      runtime.status = {
        ...runtime.status,
        state: "ready",
        protocolVersion: initialized.protocolVersion,
        implementation: normalizeImplementation(initialized.agentInfo),
        capabilities: normalizeCapabilities(initialized),
        authMethods: (initialized.authMethods ?? []).map((method) => ({
          id: method.id,
          name: method.name,
          ...(method.description ? { description: method.description } : {}),
          type: "type" in method && method.type === "terminal" ? "terminal" : "agent"
        })),
        lastError: undefined
      };
      await this.refreshRemoteSessions(runtime).catch(() => undefined);
      await this.reconcileSessionsAfterReconnect(runtime, generation);
      this.emitState();
      return clone(runtime.status);
    } catch (error) {
      runtime.status.state = "error";
      runtime.status.lastError = safeError(error);
      connection.close(error);
      child.kill();
      this.emitState();
      throw error;
    }
  }

  private async refreshRemoteSessions(runtime: AgentRuntime): Promise<void> {
    if (!runtime.connection || !runtime.status.capabilities.session.list) return;
    const collected: AcpAgentStatusView["availableSessions"] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await runtime.connection.agent.request(acp.methods.agent.session.list, {
        ...(cursor ? { cursor } : {})
      });
      collected.push(...result.sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        additionalDirectories: session.additionalDirectories ?? [],
        ...(session.title ? { title: session.title } : {}),
        ...(session.updatedAt ? { updatedAt: session.updatedAt } : {})
      })));
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    runtime.status.availableSessions = collected;
  }

  /**
   * Adapter processes are disposable, but the agent-side session ids are not.
   * When a lazy start follows an adapter disconnect, restore each local error
   * session before the caller retries its operation. Resume preserves the
   * live session when available; load is the compatible history fallback.
   */
  private async reconcileSessionsAfterReconnect(runtime: AgentRuntime, generation: number): Promise<void> {
    const connection = runtime.connection;
    if (!connection || runtime.generation !== generation || runtime.status.state !== "ready") return;

    const sessions = [...this.sessions.values()].filter(
      (session) => session.agent === runtime.status.id && session.state === "error"
    );
    for (const session of sessions) {
      if (runtime.generation !== generation || runtime.connection !== connection || runtime.status.state !== "ready") return;

      const canResume = runtime.status.capabilities.session.resume;
      const canLoad = runtime.status.capabilities.loadSession;
      if (!canResume && !canLoad) {
        session.error = `${runtime.descriptor.label} cannot restore this session after reconnect because the adapter advertises neither resume nor history loading.`;
        this.appendError(session, session.error);
        this.markSession(session, true);
        continue;
      }

      session.state = "connecting";
      session.error = undefined;
      this.appendStatus(session, "Reconnecting ACP session");
      this.markSession(session, true);

      const request = {
        sessionId: session.agentSessionId,
        cwd: session.cwd,
        additionalDirectories: session.additionalDirectories,
        mcpServers: []
      };

      try {
        let response: unknown;
        let restoredBy: "resume" | "load";
        if (canResume) {
          try {
            response = await connection.agent.request(acp.methods.agent.session.resume, request);
            restoredBy = "resume";
          } catch (resumeError) {
            if (!canLoad) throw resumeError;
            response = await connection.agent.request(acp.methods.agent.session.load, request);
            restoredBy = "load";
          }
        } else {
          response = await connection.agent.request(acp.methods.agent.session.load, request);
          restoredBy = "load";
        }

        // A second disconnect owns the session state now. Its close handler
        // has already moved every affected session back to error.
        if (runtime.generation !== generation || runtime.connection !== connection || runtime.status.state !== "ready") return;

        const record = asRecord(response);
        session.modes = normalizeModes(record?.modes as acp.SessionModeState | null | undefined);
        session.configOptions = normalizeConfigOptions(record?.configOptions as acp.SessionConfigOption[] | null | undefined);
        session.state = "ready";
        session.error = undefined;
        this.appendStatus(session, restoredBy === "resume" ? "Session resumed after ACP reconnect" : "Session history loaded after ACP reconnect");
        this.markSession(session, true);
      } catch (error) {
        if (runtime.generation !== generation || runtime.connection !== connection || runtime.status.state !== "ready") return;
        session.state = "error";
        session.error = safeError(error);
        this.appendError(session, session.error);
        this.markSession(session, true);
      }
    }
  }

  private async readyRuntime(agent: AcpAgentId): Promise<AgentRuntime> {
    await this.startAgent(agent);
    const runtime = this.requireAgent(agent);
    if (!runtime.connection || runtime.status.state !== "ready") throw new Error(`${runtime.descriptor.label} ACP is unavailable.`);
    return runtime;
  }

  private requireAgent(agent: AcpAgentId): AgentRuntime {
    const runtime = this.agents.get(agent);
    if (!runtime) throw new Error("Unknown ACP agent.");
    return runtime;
  }

  private requireSession(id: string): AcpSessionView {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown ACP session.");
    return session;
  }

  private sessionForRemote(agent: AcpAgentId, remoteSessionId: string): AcpSessionView | undefined {
    const id = this.remoteSessions.get(agentKey(agent, remoteSessionId));
    return id ? this.sessions.get(id) : undefined;
  }

  private sessionAndSubagentForRemote(
    agent: AcpAgentId,
    remoteSessionId: string
  ): { session?: AcpSessionView; subagent?: AcpSubagentView } {
    const direct = this.sessionForRemote(agent, remoteSessionId);
    if (direct) return { session: direct };
    const link = this.subagentLinks.get(agentKey(agent, remoteSessionId));
    if (!link) return {};
    const session = this.sessions.get(link.rootSessionId);
    return { session, subagent: session?.subagents.find((candidate) => candidate.id === link.subagentId) };
  }

  private newSessionView(
    runtime: AgentRuntime,
    remoteSessionId: string,
    cwd: string,
    additionalDirectories: string[],
    response: { modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null } = {}
  ): AcpSessionView {
    const now = new Date().toISOString();
    return {
      id: publicSessionId(runtime.status.id, remoteSessionId),
      agentSessionId: remoteSessionId,
      agent: runtime.status.id,
      title: `${runtime.descriptor.label} · ${path.basename(cwd) || cwd}`,
      cwd,
      additionalDirectories,
      state: "ready",
      createdAt: now,
      updatedAt: now,
      modes: normalizeModes(response.modes),
      configOptions: normalizeConfigOptions(response.configOptions),
      availableCommands: [],
      plan: [],
      failures: [],
      fileChangeReports: [],
      timeline: [],
      terminals: [],
      subagents: []
    };
  }

  private putSession(session: AcpSessionView): void {
    this.sessions.set(session.id, session);
    this.remoteSessions.set(agentKey(session.agent, session.agentSessionId), session.id);
    this.appendStatus(session, "ACP session ready");
    this.markSession(session, true);
    this.emitState();
  }

  private startPrompt(
    runtime: AgentRuntime,
    session: AcpSessionView,
    prompt: acp.ContentBlock[],
    options: { reportFileChanges?: boolean },
    recordUser: boolean
  ): AcpSessionView {
    if (recordUser) this.recordUserPrompt(session, prompt);
    session.state = "prompting";
    session.error = undefined;
    session.lastStopReason = undefined;
    this.markSession(session, true);
    const reportId = `terminal-web:${randomUUID()}`;
    const requestMeta = options.reportFileChanges && runtime.status.capabilities.fileChangeReports
      ? {
          jetbrains: {
            air: {
              agentFileChangeReportRequest: { version: 1, requestId: reportId }
            }
          }
        }
      : undefined;
    const connection = runtime.connection!;
    const generation = runtime.generation;
    const ownsRuntime = () => runtime.generation === generation && runtime.connection === connection && runtime.status.state === "ready";
    let task!: Promise<void>;
    task = connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.agentSessionId,
      prompt,
      ...(requestMeta ? { _meta: requestMeta } : {})
    }).then((response) => {
      if (!ownsRuntime()) return;
      session.lastStopReason = response.stopReason;
      session.state = "ready";
      const usage = normalizeUsage(response.usage);
      if (usage) session.usage = { ...(session.usage ?? {}), ...usage };
      this.applyKnownMeta(session, response._meta);
      this.appendStatus(session, this.stopReasonLabel(response.stopReason));
    }).catch((error) => {
      // The connection-close path owns the error state. A rejected request
      // from that stale connection must not make a dead session look ready,
      // nor overwrite a session that a newer adapter generation restored.
      if (!ownsRuntime()) return;
      session.state = "ready";
      session.error = safeError(error);
      this.appendError(session, session.error);
    }).finally(() => {
      if (this.promptTasks.get(session.id) !== task) return;
      this.promptTasks.delete(session.id);
      this.cancelPendingForSession(session);
      this.markSession(session, true);
      const currentRuntime = this.agents.get(session.agent);
      if (currentRuntime) void this.refreshRemoteSessions(currentRuntime).then(() => this.emitState()).catch(() => undefined);
    });
    this.promptTasks.set(session.id, task);
    return clone(session);
  }

  private protocolPrompt(runtime: AgentRuntime, blocks: AcpPromptBlockInput[]): acp.ContentBlock[] {
    if (blocks.length > MAX_PROMPT_BLOCKS) {
      throw new Error(`A prompt can contain at most ${MAX_PROMPT_BLOCKS} content blocks.`);
    }
    const result: acp.ContentBlock[] = [];
    let textCharacters = 0;
    let binaryBytes = 0;
    for (const block of blocks) {
      if (block.type === "text") {
        textCharacters += block.text.length;
        if (textCharacters > MAX_PROMPT_TEXT_CHARS) throw new Error("Prompt text is too large.");
        if (block.text) result.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        if (!runtime.status.capabilities.prompt.image) throw new Error(`${runtime.descriptor.label} does not accept image prompts.`);
        binaryBytes += Buffer.byteLength(block.data, "base64");
        if (binaryBytes > MAX_PROMPT_BINARY_BYTES) throw new Error("Prompt attachments are too large.");
        result.push({ type: "image", mimeType: block.mimeType, data: block.data, ...(block.uri ? { uri: block.uri } : {}) });
      } else if (block.type === "audio") {
        if (!runtime.status.capabilities.prompt.audio) throw new Error(`${runtime.descriptor.label} does not accept audio prompts.`);
        binaryBytes += Buffer.byteLength(block.data, "base64");
        if (binaryBytes > MAX_PROMPT_BINARY_BYTES) throw new Error("Prompt attachments are too large.");
        result.push({ type: "audio", mimeType: block.mimeType, data: block.data });
      } else if (block.type === "resource_link") {
        result.push({
          type: "resource_link",
          uri: block.uri,
          name: block.name,
          ...(block.title ? { title: block.title } : {}),
          ...(block.description ? { description: block.description } : {}),
          ...(block.mimeType ? { mimeType: block.mimeType } : {})
        });
      } else {
        if (!runtime.status.capabilities.prompt.embeddedContext) {
          throw new Error(`${runtime.descriptor.label} does not accept embedded context.`);
        }
        textCharacters += block.text.length;
        if (textCharacters > MAX_PROMPT_TEXT_CHARS) throw new Error("Prompt context is too large.");
        result.push({
          type: "resource",
          resource: {
            uri: block.uri,
            text: block.text,
            ...(block.mimeType ? { mimeType: block.mimeType } : {})
          }
        });
      }
    }
    return result;
  }

  private recordUserPrompt(session: AcpSessionView, prompt: acp.ContentBlock[], title?: string): void {
    for (const block of prompt) {
      this.appendTimeline(session.timeline, {
        id: randomUUID(),
        at: new Date().toISOString(),
        kind: "user",
        ...(title ? { title } : {}),
        content: normalizeContent(block),
        ...(block.type === "text" ? { text: truncate(block.text) } : {})
      }, MAX_TIMELINE_ITEMS);
    }
  }

  private async requestPermission(
    agent: AcpAgentId,
    params: acp.RequestPermissionRequest,
    signal: AbortSignal
  ): Promise<acp.RequestPermissionResponse> {
    const located = this.sessionAndSubagentForRemote(agent, params.sessionId);
    const id = randomUUID();
    const options: AcpPermissionOptionView[] = params.options.map((option) => {
      const optionPresentation = asRecord(asRecord(option._meta)?.permission);
      const description = optionalString(optionPresentation?.description);
      return {
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
        ...(description ? { description } : {})
      };
    });
    const presentation = asRecord(asRecord(params._meta)?.permission);
    return new Promise((resolve) => {
      const view: AcpInteractiveRequestView = {
        id,
        agent,
        ...(located.session ? { sessionId: located.session.id } : {}),
        createdAt: new Date().toISOString(),
        kind: "permission",
        title: optionalString(presentation?.title) ?? params.toolCall.title ?? "Permission required",
        ...(optionalString(presentation?.description) ? { message: optionalString(presentation?.description) } : {}),
        toolCall: normalizeToolCall(params.toolCall),
        options
      };
      const pending: PendingPermission = { kind: "permission", view, remoteSessionId: params.sessionId, resolve };
      this.pending.set(id, pending);
      signal.addEventListener("abort", () => {
        if (this.pending.delete(id)) resolve({ outcome: { outcome: "cancelled" } });
        this.emitState();
      }, { once: true });
      this.emitState();
    });
  }

  private async requestElicitation(
    agent: AcpAgentId,
    params: acp.CreateElicitationRequest,
    signal: AbortSignal
  ): Promise<acp.CreateElicitationResponse> {
    const record = asRecord(params)!;
    const remoteSessionId = optionalString(record.sessionId);
    const located = remoteSessionId ? this.sessionAndSubagentForRemote(agent, remoteSessionId) : {};
    const id = randomUUID();
    const schema = asRecord(record.requestedSchema);
    const mode = params.mode;
    const url = mode === "url" && "url" in params && typeof params.url === "string" ? params.url : undefined;
    const elicitationId =
      mode === "url" && "elicitationId" in params && typeof params.elicitationId === "string"
        ? params.elicitationId
        : undefined;
    return new Promise((resolve) => {
      const view: AcpInteractiveRequestView = {
        id,
        agent,
        ...(located.session ? { sessionId: located.session.id } : {}),
        createdAt: new Date().toISOString(),
        kind: mode === "form" ? "elicitation_form" : "elicitation_url",
        title: mode === "form"
          ? `${this.requireAgent(agent).descriptor.label} needs a few details`
          : "Continue in your browser",
        message: params.message,
        ...(schema ? { requestedSchema: clone(schema) } : {}),
        ...(url ? { url } : {})
      };
      const pending: PendingElicitation = {
        kind: "elicitation",
        view,
        remoteSessionId,
        ...(elicitationId ? { elicitationId } : {}),
        schema,
        resolve
      };
      this.pending.set(id, pending);
      signal.addEventListener("abort", () => {
        if (this.pending.delete(id)) resolve({ action: "cancel" });
        this.emitState();
      }, { once: true });
      this.emitState();
    });
  }

  private completeElicitation(agent: AcpAgentId, params: acp.CompleteElicitationNotification): void {
    for (const [id, pending] of this.pending) {
      if (pending.kind === "elicitation" && pending.view.agent === agent && pending.elicitationId === params.elicitationId) {
        this.pending.delete(id);
        pending.resolve({ action: "accept" });
      }
    }
    this.emitState();
  }

  private handleSessionUpdate(agent: AcpAgentId, notification: acp.SessionNotification): void {
    const located = this.sessionAndSubagentForRemote(agent, notification.sessionId);
    if (!located.session) return;
    const update = notification.update;
    const meta = asRecord(update._meta);
    const original = asRecord(asRecord(meta?.terminalWeb)?.originalSessionUpdate) as SessionUpdateRecord | undefined;
    if (original) {
      this.handleExtensionUpdate(agent, located.session, located.subagent, notification.sessionId, original);
      this.applyKnownMeta(located.session, original._meta);
      this.markSession(located.session);
      return;
    }

    this.applyKnownMeta(located.session, update._meta);
    this.applyAdapterTerminalMeta(located.session, update);
    if (located.subagent) {
      this.applyTimelineUpdate(located.subagent.timeline, update, MAX_SUBAGENT_TIMELINE_ITEMS);
    } else {
      this.applySessionUpdate(located.session, update);
    }
    this.markSession(located.session);
  }

  private applySessionUpdate(session: AcpSessionView, update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
      case "agent_message_chunk":
      case "agent_thought_chunk":
      case "tool_call":
      case "tool_call_update":
        this.applyTimelineUpdate(session.timeline, update, MAX_TIMELINE_ITEMS);
        break;
      case "plan":
        session.plan = normalizePlan(update.entries);
        this.appendTimeline(session.timeline, {
          id: randomUUID(), at: new Date().toISOString(), kind: "plan", title: "Plan updated", plan: session.plan
        }, MAX_TIMELINE_ITEMS);
        break;
      case "plan_update": {
        const content = asRecord(update.plan);
        if (content?.type === "items" && Array.isArray(content.entries)) {
          session.plan = normalizePlan(content.entries as acp.PlanEntry[]);
        }
        this.appendTimeline(session.timeline, {
          id: randomUUID(), at: new Date().toISOString(), kind: "plan", title: "Plan updated",
          ...(typeof content?.content === "string" ? { text: truncate(content.content) } : {}),
          ...(session.plan.length ? { plan: session.plan } : {})
        }, MAX_TIMELINE_ITEMS);
        break;
      }
      case "plan_removed":
        session.plan = [];
        this.appendStatus(session, "Plan removed");
        break;
      case "available_commands_update":
        session.availableCommands = update.availableCommands.map((command): AcpAvailableCommandView => ({
          name: command.name,
          description: command.description,
          ...(command.input?.hint ? { inputHint: command.input.hint } : {})
        }));
        break;
      case "current_mode_update":
        if (session.modes) session.modes.currentModeId = update.currentModeId;
        break;
      case "config_option_update":
        session.configOptions = normalizeConfigOptions(update.configOptions);
        break;
      case "session_info_update":
        if (update.title !== undefined) session.title = update.title || `${session.agent === "claude" ? "Claude" : "Codex"} session`;
        if (update.updatedAt) session.updatedAt = update.updatedAt;
        break;
      case "usage_update": {
        const usage = normalizeUsage(update);
        if (usage) session.usage = { ...(session.usage ?? {}), ...usage };
        break;
      }
      case "compaction_update":
        this.appendStatus(session, "Context compacted");
        break;
      case "compaction_summary_chunk":
        this.applyTimelineUpdate(session.timeline, {
          sessionUpdate: "agent_thought_chunk",
          content: update.content,
          messageId: `compaction:${update.compactionId}`
        }, MAX_TIMELINE_ITEMS);
        break;
    }
  }

  private applyTimelineUpdate(
    timeline: AcpTimelineItemView[],
    update: acp.SessionUpdate,
    limit: number
  ): void {
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const existing = [...timeline].reverse().find((item) => item.toolCall?.toolCallId === update.toolCallId);
      if (existing?.toolCall) {
        existing.toolCall = normalizeToolCall({ ...existing.toolCall, ...update, toolCallId: update.toolCallId } as Partial<acp.ToolCall> & { toolCallId: string });
        existing.at = new Date().toISOString();
      } else {
        const tool = normalizeToolCall(update as Partial<acp.ToolCall> & { toolCallId: string });
        this.appendTimeline(timeline, {
          id: randomUUID(), at: new Date().toISOString(), kind: "tool", title: tool.title, toolCall: tool
        }, limit);
      }
      return;
    }
    if (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") return;
    const kind = update.sessionUpdate === "user_message_chunk" ? "user" : update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought";
    const content = normalizeContent(update.content);
    const last = timeline.at(-1);
    if (content.type === "text" && last?.kind === kind && last.messageId === update.messageId && last.content?.type === "text") {
      const text = truncate(`${last.text ?? ""}${content.text}`);
      last.text = text;
      last.content = { type: "text", text };
      last.at = new Date().toISOString();
      return;
    }
    this.appendTimeline(timeline, {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind,
      ...(update.messageId ? { messageId: update.messageId } : {}),
      content,
      ...(content.type === "text" ? { text: content.text } : {})
    }, limit);
  }

  private handleExtensionUpdate(
    agent: AcpAgentId,
    session: AcpSessionView,
    parentSubagent: AcpSubagentView | undefined,
    remoteSessionId: string,
    update: SessionUpdateRecord
  ): void {
    if (update.sessionUpdate === "subagent_spawned") {
      const childId = optionalString(update.subagentSessionId);
      if (!childId) return;
      const existing = session.subagents.find((candidate) => candidate.id === childId);
      if (!existing) {
        session.subagents.push({
          id: childId,
          ...(parentSubagent ? { parentId: parentSubagent.id } : {}),
          name: optionalString(update.name) ?? "Subagent",
          task: optionalString(update.task) ?? "Delegated task",
          state: "running",
          timeline: []
        });
      }
      this.subagentLinks.set(agentKey(agent, childId), { rootSessionId: session.id, subagentId: childId });
      this.appendTimeline(parentSubagent?.timeline ?? session.timeline, {
        id: randomUUID(), at: new Date().toISOString(), kind: "extension", title: "Subagent started",
        extension: { method: "subagent_spawned", summary: optionalString(update.task) ?? "Delegated task" }
      }, parentSubagent ? MAX_SUBAGENT_TIMELINE_ITEMS : MAX_TIMELINE_ITEMS);
      return;
    }
    if (update.sessionUpdate === "subagent_state_update") {
      const childId = optionalString(update.subagentSessionId);
      const child = session.subagents.find((candidate) => candidate.id === childId);
      const state = optionalString(update.state);
      if (child && (state === "completed" || state === "failed" || state === "cancelled")) child.state = state;
      return;
    }
    this.appendTimeline(parentSubagent?.timeline ?? session.timeline, {
      id: randomUUID(), at: new Date().toISOString(), kind: "extension", title: "Agent update",
      extension: { method: update.sessionUpdate, summary: "Structured extension update" }
    }, parentSubagent ? MAX_SUBAGENT_TIMELINE_ITEMS : MAX_TIMELINE_ITEMS);
    void remoteSessionId;
  }

  private applyKnownMeta(session: AcpSessionView, value: unknown): void {
    const meta = asRecord(value);
    if (!meta) return;
    if (Object.prototype.hasOwnProperty.call(meta, "goal")) {
      const goal = asRecord(meta.goal);
      if (!goal) {
        session.goal = undefined;
      } else if (typeof goal.objective === "string" && typeof goal.status === "string") {
        session.goal = {
          objective: goal.objective,
          status: goal.status as AcpGoalView["status"],
          ...(optionalNumber(goal.iterations) !== undefined ? { iterations: optionalNumber(goal.iterations) } : {}),
          ...(optionalString(goal.lastReason) ? { lastReason: optionalString(goal.lastReason) } : {}),
          ...(optionalNumber(goal.createdAt) !== undefined ? { createdAt: optionalNumber(goal.createdAt) } : {}),
          ...(optionalNumber(goal.updatedAt) !== undefined ? { updatedAt: optionalNumber(goal.updatedAt) } : {}),
          ...(optionalNumber(goal.tokenBudget) !== undefined ? { tokenBudget: optionalNumber(goal.tokenBudget) } : {}),
          ...(optionalNumber(goal.tokensUsed) !== undefined ? { tokensUsed: optionalNumber(goal.tokensUsed) } : {}),
          ...(optionalNumber(goal.timeUsedSeconds) !== undefined ? { timeUsedSeconds: optionalNumber(goal.timeUsedSeconds) } : {})
        };
      }
    }
    const air = asRecord(asRecord(meta.jetbrains)?.air);
    const failure = asRecord(air?.sessionFailure);
    if (failure && typeof failure.id === "string" && typeof failure.revision === "number" && typeof failure.title === "string") {
      const normalized: AcpSessionFailureView = {
        id: failure.id,
        revision: failure.revision,
        category: optionalString(failure.category) ?? "unknown",
        severity: failure.severity === "warning" ? "warning" : "error",
        title: truncate(failure.title, 500),
        ...(optionalString(failure.details) ? { details: truncate(optionalString(failure.details)!, 2_000) } : {}),
        actions: Array.isArray(failure.actions)
          ? failure.actions.filter((item): item is string => typeof item === "string")
          : []
      };
      const index = session.failures.findIndex((item) => item.id === normalized.id);
      if (index >= 0) {
        if (session.failures[index]!.revision <= normalized.revision) session.failures[index] = normalized;
      } else {
        session.failures.push(normalized);
        if (session.failures.length > 30) session.failures.shift();
      }
    }
    const report = asRecord(air?.agentFileChangeReport);
    if (report && typeof report.requestId === "string" && (report.status === "reported" || report.status === "unavailable")) {
      let normalized: AcpFileChangeReportView;
      if (report.status === "reported") {
        normalized = {
          requestId: report.requestId,
          status: "reported",
          paths: Array.isArray(report.paths) ? report.paths.filter((item): item is string => typeof item === "string").slice(0, 1024) : [],
          declaredComplete: report.declaredComplete === true,
          truncated: report.truncated === true,
          ...(optionalString(report.uncertainty) ? { uncertainty: truncate(optionalString(report.uncertainty)!, 2_000) } : {})
        };
      } else {
        normalized = { requestId: report.requestId, status: "unavailable", reason: optionalString(report.reason) ?? "unknown" };
      }
      const index = session.fileChangeReports.findIndex((item) => item.requestId === normalized.requestId);
      if (index >= 0) session.fileChangeReports[index] = normalized;
      else session.fileChangeReports.push(normalized);
      if (session.fileChangeReports.length > 30) session.fileChangeReports.shift();
    }
  }

  private applyAdapterTerminalMeta(session: AcpSessionView, update: acp.SessionUpdate): void {
    const meta = asRecord(update._meta);
    if (!meta) return;
    const info = asRecord(meta.terminal_info);
    const fullOutput = asRecord(meta.terminal_output);
    const outputDelta = asRecord(meta.terminal_output_delta);
    const exit = asRecord(meta.terminal_exit);
    const terminalId =
      optionalString(info?.terminal_id) ??
      optionalString(fullOutput?.terminal_id) ??
      optionalString(outputDelta?.terminal_id) ??
      optionalString(exit?.terminal_id);
    if (!terminalId) return;
    let terminal = session.terminals.find((candidate) => candidate.id === terminalId);
    if (!terminal) {
      const title =
        update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
          ? optionalString(update.title)
          : undefined;
      terminal = {
        id: terminalId,
        sessionId: session.id,
        command: title ?? "Agent terminal",
        args: [],
        cwd: optionalString(info?.cwd) ?? session.cwd,
        state: "running",
        output: "",
        truncated: false
      };
      session.terminals.push(terminal);
    }
    if (optionalString(info?.cwd)) terminal.cwd = optionalString(info?.cwd)!;
    const output = typeof fullOutput?.data === "string" ? fullOutput.data : undefined;
    const delta = typeof outputDelta?.data === "string" ? outputDelta.data : undefined;
    // Both current adapters define terminal_output and the legacy
    // terminal_output_delta as append-only chunks (neither is a snapshot).
    if (output !== undefined) terminal.output = truncate(`${terminal.output}${output}`, MAX_TEXT_CHARS);
    if (delta !== undefined) terminal.output = truncate(`${terminal.output}${delta}`, MAX_TEXT_CHARS);
    if ((output?.length ?? 0) > MAX_TEXT_CHARS || terminal.output.includes("… [truncated]")) terminal.truncated = true;
    if (exit) {
      terminal.state = "exited";
      if (typeof exit.exit_code === "number") terminal.exitCode = exit.exit_code;
      if (typeof exit.signal === "string") terminal.signal = exit.signal;
    }
  }

  private appendTimeline(timeline: AcpTimelineItemView[], item: AcpTimelineItemView, limit: number): void {
    timeline.push(item);
    if (timeline.length > limit) timeline.splice(0, timeline.length - limit);
  }

  private appendStatus(session: AcpSessionView, text: string): void {
    this.appendTimeline(session.timeline, {
      id: randomUUID(), at: new Date().toISOString(), kind: "status", text
    }, MAX_TIMELINE_ITEMS);
  }

  private appendError(session: AcpSessionView, text: string): void {
    this.appendTimeline(session.timeline, {
      id: randomUUID(), at: new Date().toISOString(), kind: "error", title: "Agent error", text
    }, MAX_TIMELINE_ITEMS);
  }

  private markSession(session: AcpSessionView, immediate = false): void {
    session.updatedAt = new Date().toISOString();
    const emit = () => {
      this.broadcastTimers.delete(session.id);
      if (this.sessions.has(session.id)) {
        this.sequence += 1;
        this.emit("session", {
          epoch: this.epoch,
          sequence: this.sequence,
          session: clone(session)
        });
      }
    };
    if (immediate) {
      const timer = this.broadcastTimers.get(session.id);
      if (timer) clearTimeout(timer);
      emit();
    } else if (!this.broadcastTimers.has(session.id)) {
      const timer = setTimeout(emit, SESSION_BROADCAST_MS);
      timer.unref?.();
      this.broadcastTimers.set(session.id, timer);
    }
  }

  private emitState(): void {
    this.sequence += 1;
    this.emit("state", this.state());
  }

  private stopReasonLabel(reason: acp.StopReason): string {
    switch (reason) {
      case "end_turn": return "Turn complete";
      case "cancelled": return "Turn cancelled";
      case "max_tokens": return "Stopped at token limit";
      case "max_turn_requests": return "Stopped at turn limit";
      case "refusal": return "Request refused";
    }
  }

  private cancelPendingForAgent(agent: AcpAgentId): void {
    for (const [id, pending] of this.pending) {
      if (pending.view.agent !== agent) continue;
      this.pending.delete(id);
      if (pending.kind === "permission") pending.resolve({ outcome: { outcome: "cancelled" } });
      else pending.resolve({ action: "cancel" });
    }
  }

  private cancelPendingForSession(session: AcpSessionView): void {
    for (const [id, pending] of this.pending) {
      if (pending.view.sessionId !== session.id) continue;
      this.pending.delete(id);
      if (pending.kind === "permission") pending.resolve({ outcome: { outcome: "cancelled" } });
      else pending.resolve({ action: "cancel" });
    }
    this.emitState();
  }

  private async workspaceDirectory(value: string): Promise<string> {
    if (!value || !path.isAbsolute(value)) throw new Error("ACP working directories must be absolute paths.");
    const resolved = await realpath(value);
    const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error("ACP working directory is not a directory.");
    return resolved;
  }

  private async additionalDirectories(runtime: AgentRuntime, values: string[]): Promise<string[]> {
    if (values.length > 0 && !runtime.status.capabilities.session.additionalDirectories) {
      throw new Error(`${runtime.descriptor.label} does not advertise additional workspace directories.`);
    }
    const result: string[] = [];
    for (const value of values) result.push(await this.workspaceDirectory(value));
    return [...new Set(result)];
  }

  private async allowedPath(agent: AcpAgentId, remoteSessionId: string, target: string, forWrite: boolean): Promise<string> {
    const located = this.sessionAndSubagentForRemote(agent, remoteSessionId);
    if (!located.session) throw new Error("Unknown ACP session for file request.");
    if (!path.isAbsolute(target)) throw new Error("ACP file requests must use absolute paths.");
    const roots = [located.session.cwd, ...located.session.additionalDirectories];
    let resolved: string;
    if (forWrite) {
      const parent = await realpath(path.dirname(target));
      resolved = path.join(parent, path.basename(target));
    } else {
      resolved = await realpath(target);
    }
    const folded = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const allowed = roots.some((root) => {
      const candidate = process.platform === "win32" ? root.toLowerCase() : root;
      return folded === candidate || folded.startsWith(`${candidate}${path.sep}`);
    });
    if (!allowed) throw new Error("ACP file request is outside this session's workspace roots.");
    return resolved;
  }

  private async readTextFile(agent: AcpAgentId, params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const filePath = await this.allowedPath(agent, params.sessionId, params.path, false);
    const content = await readFile(filePath, "utf8");
    if (params.line == null && params.limit == null) return { content };
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, Math.floor(params.line ?? 1) - 1);
    const count = params.limit == null ? lines.length : Math.max(0, Math.floor(params.limit));
    return { content: lines.slice(start, start + count).join("\n") };
  }

  private async writeTextFile(agent: AcpAgentId, params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const filePath = await this.allowedPath(agent, params.sessionId, params.path, true);
    await writeFile(filePath, params.content, "utf8");
    return {};
  }

  private async createTerminal(agent: AcpAgentId, params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    const located = this.sessionAndSubagentForRemote(agent, params.sessionId);
    if (!located.session) throw new Error("Unknown ACP session for terminal request.");
    const cwd = params.cwd
      ? await this.allowedPath(agent, params.sessionId, params.cwd, false)
      : located.session.cwd;
    const cwdDetails = await stat(cwd);
    if (!cwdDetails.isDirectory()) throw new Error("Terminal working directory is not a directory.");
    const terminalId = randomUUID();
    const byteLimit = Math.max(1, Math.min(params.outputByteLimit ?? DEFAULT_TERMINAL_BYTES, MAX_TERMINAL_BYTES));
    const env = { ...process.env };
    for (const entry of params.env ?? []) env[entry.name] = entry.value;
    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let resolveExit!: RuntimeTerminal["resolveExit"];
    const exitPromise = new Promise<{ exitCode?: number; signal?: string }>((resolve) => {
      resolveExit = resolve;
    });
    const view: AcpTerminalView = {
      id: terminalId,
      sessionId: located.session.id,
      command: params.command,
      args: params.args ?? [],
      cwd,
      state: "running",
      output: "",
      truncated: false
    };
    const terminal: RuntimeTerminal = { view, remoteSessionId: params.sessionId, child, byteLimit, exitPromise, resolveExit };
    this.terminals.set(terminalId, terminal);
    located.session.terminals.push(view);
    const append = (chunk: Buffer | string) => {
      const next = Buffer.from(`${view.output}${chunk.toString()}`, "utf8");
      if (next.length <= byteLimit) {
        view.output = next.toString("utf8");
      } else {
        let start = next.length - byteLimit;
        while (start < next.length && (next[start]! & 0xc0) === 0x80) start += 1;
        view.output = next.subarray(start).toString("utf8");
        view.truncated = true;
      }
      this.markSession(located.session!);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => append(`\n${safeError(error)}\n`));
    child.on("exit", (code, signal) => {
      view.state = "exited";
      if (code != null) view.exitCode = code;
      if (signal) view.signal = String(signal);
      resolveExit({ ...(code != null ? { exitCode: code } : {}), ...(signal ? { signal: String(signal) } : {}) });
      this.markSession(located.session!, true);
    });
    this.markSession(located.session, true);
    return { terminalId };
  }

  private terminalOutput(params: acp.TerminalOutputRequest): acp.TerminalOutputResponse {
    const terminal = this.requireTerminal(params.terminalId, params.sessionId);
    return {
      output: terminal.view.output,
      truncated: terminal.view.truncated,
      ...(terminal.view.state !== "running"
        ? { exitStatus: { exitCode: terminal.view.exitCode ?? null, signal: terminal.view.signal ?? null } }
        : {})
    };
  }

  private async waitForTerminal(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse> {
    const terminal = this.requireTerminal(params.terminalId, params.sessionId);
    return terminal.exitPromise;
  }

  private killTerminal(params: acp.KillTerminalRequest): acp.KillTerminalResponse {
    const terminal = this.requireTerminal(params.terminalId, params.sessionId);
    if (terminal.view.state === "running") terminal.child.kill();
    return {};
  }

  private releaseTerminal(params: acp.ReleaseTerminalRequest): acp.ReleaseTerminalResponse {
    const terminal = this.requireTerminal(params.terminalId, params.sessionId);
    if (terminal.view.state === "running") terminal.child.kill();
    terminal.view.state = "released";
    this.terminals.delete(params.terminalId);
    const session = this.sessions.get(terminal.view.sessionId);
    if (session) this.markSession(session, true);
    return {};
  }

  private requireTerminal(terminalId: string, remoteSessionId: string): RuntimeTerminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.remoteSessionId !== remoteSessionId) throw new Error("Unknown ACP terminal.");
    return terminal;
  }

  private releaseSessionTerminals(session: AcpSessionView): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.view.sessionId !== session.id) continue;
      if (terminal.view.state === "running") terminal.child.kill();
      terminal.view.state = "released";
      this.terminals.delete(terminal.view.id);
    }
  }

  private validateElicitationContent(schema: Record<string, unknown> | undefined, content: Record<string, unknown>): void {
    if (!schema) return;
    const properties = asRecord(schema.properties) ?? {};
    if (Object.keys(properties).length === 0) {
      for (const [key, value] of Object.entries(content)) {
        if (key !== "value" || (!["string", "number", "boolean"].includes(typeof value)
          && !(Array.isArray(value) && value.every((item) => typeof item === "string")))) {
          throw new Error("This request uses an unsupported form shape.");
        }
      }
      return;
    }
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!(key in content)) throw new Error(`“${key}” is required.`);
    }
    for (const [key, value] of Object.entries(content)) {
      const property = asRecord(properties[key]);
      if (!property) throw new Error(`“${key}” is not part of this request.`);
      switch (property.type) {
        case "string": {
          if (typeof value !== "string") throw new Error(`“${key}” must be text.`);
          const allowed = Array.isArray(property.enum)
            ? property.enum
            : Array.isArray(property.oneOf)
              ? property.oneOf.map((item) => asRecord(item)?.const).filter((item): item is string => typeof item === "string")
              : undefined;
          if (allowed && !allowed.includes(value)) throw new Error(`“${key}” has an unavailable value.`);
          if (typeof property.minLength === "number" && value.length < property.minLength) {
            throw new Error(`“${key}” must contain at least ${property.minLength} characters.`);
          }
          if (typeof property.maxLength === "number" && value.length > property.maxLength) {
            throw new Error(`“${key}” must contain at most ${property.maxLength} characters.`);
          }
          if (typeof property.pattern === "string") {
            if (property.pattern.length > 512) throw new Error(`“${key}” has an unsupported validation pattern.`);
            let pattern: RegExp;
            try {
              pattern = new RegExp(property.pattern);
            } catch {
              throw new Error(`“${key}” has an invalid validation pattern.`);
            }
            if (!pattern.test(value)) throw new Error(`“${key}” does not match the required format.`);
          }
          if (property.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            throw new Error(`“${key}” must be an email address.`);
          }
          if (property.format === "uri") {
            try {
              new URL(value);
            } catch {
              throw new Error(`“${key}” must be a complete URL.`);
            }
          }
          if (property.format === "date") {
            const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : undefined;
            if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
              throw new Error(`“${key}” must be a date in YYYY-MM-DD format.`);
            }
          }
          if (property.format === "date-time" && !Number.isFinite(Date.parse(value))) {
            throw new Error(`“${key}” must be a valid date and time.`);
          }
          break;
        }
        case "number":
          if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`“${key}” must be a number.`);
          if (typeof property.minimum === "number" && value < property.minimum) throw new Error(`“${key}” must be at least ${property.minimum}.`);
          if (typeof property.maximum === "number" && value > property.maximum) throw new Error(`“${key}” must be at most ${property.maximum}.`);
          break;
        case "integer":
          if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`“${key}” must be a whole number.`);
          if (typeof property.minimum === "number" && value < property.minimum) throw new Error(`“${key}” must be at least ${property.minimum}.`);
          if (typeof property.maximum === "number" && value > property.maximum) throw new Error(`“${key}” must be at most ${property.maximum}.`);
          break;
        case "boolean":
          if (typeof value !== "boolean") throw new Error(`“${key}” must be on or off.`);
          break;
        case "array":
          if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
            throw new Error(`“${key}” must be a list of selections.`);
          }
          if (typeof property.minItems === "number" && value.length < property.minItems) {
            throw new Error(`“${key}” requires at least ${property.minItems} selections.`);
          }
          if (typeof property.maxItems === "number" && value.length > property.maxItems) {
            throw new Error(`“${key}” allows at most ${property.maxItems} selections.`);
          }
          const items = asRecord(property.items);
          const itemChoices = Array.isArray(items?.enum)
            ? items.enum
            : Array.isArray(items?.anyOf)
              ? items.anyOf.map((item) => asRecord(item)?.const).filter((item): item is string => typeof item === "string")
              : undefined;
          if (itemChoices && value.some((item) => !itemChoices.includes(item))) {
            throw new Error(`“${key}” contains an unavailable selection.`);
          }
          break;
        default:
          if (!["string", "number", "boolean"].includes(typeof value) && !Array.isArray(value)) {
            throw new Error(`“${key}” has an unsupported value.`);
          }
      }
    }
  }
}
