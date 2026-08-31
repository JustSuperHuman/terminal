/**
 * JSON-safe ACP view models shared by the host APIs and remote clients.
 *
 * These deliberately omit protocol `_meta` values and terminal environment
 * variables: adapters are allowed to place opaque or sensitive data there and
 * the phone never needs it to render a complete interaction.
 */
export type AcpAgentId = "claude" | "codex";
export type AcpAgentState = "stopped" | "starting" | "ready" | "error";
export type AcpSessionState = "connecting" | "ready" | "prompting" | "cancelling" | "closed" | "error";

export interface AcpImplementationView {
  name: string;
  title?: string;
  version?: string;
}

export interface AcpAuthMethodView {
  id: string;
  name: string;
  description?: string;
  type: "agent" | "terminal";
}

export interface AcpAgentCapabilitiesView {
  loadSession: boolean;
  auth: {
    logout: boolean;
  };
  prompt: {
    image: boolean;
    audio: boolean;
    embeddedContext: boolean;
  };
  session: {
    list: boolean;
    delete: boolean;
    fork: boolean;
    resume: boolean;
    close: boolean;
    additionalDirectories: boolean;
  };
  mcp: {
    acp: boolean;
    http: boolean;
    sse: boolean;
  };
  steering: boolean;
  goal: {
    supported: boolean;
    actions: string[];
  };
  sessionFailures: boolean;
  fileChangeReports: boolean;
  nativeSubagents: boolean;
  extensions: string[];
}

export interface AcpRemoteSessionView {
  sessionId: string;
  cwd: string;
  additionalDirectories: string[];
  title?: string;
  updatedAt?: string;
}

export interface AcpAgentStatusView {
  id: AcpAgentId;
  label: string;
  state: AcpAgentState;
  available: boolean;
  adapterVersion: string;
  protocolVersion?: number;
  implementation?: AcpImplementationView;
  capabilities: AcpAgentCapabilitiesView;
  authMethods: AcpAuthMethodView[];
  availableSessions: AcpRemoteSessionView[];
  lastError?: string;
}

export interface AcpModeView {
  id: string;
  name: string;
  description?: string;
}

export interface AcpModeStateView {
  currentModeId: string;
  availableModes: AcpModeView[];
}

export interface AcpConfigOptionValueView {
  value: string;
  name: string;
  description?: string;
  group?: string;
  groupName?: string;
}

export type AcpConfigOptionView =
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: "select";
      currentValue: string;
      options: AcpConfigOptionValueView[];
    }
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: "boolean";
      currentValue: boolean;
    };

export interface AcpAvailableCommandView {
  name: string;
  description: string;
  inputHint?: string;
}

export interface AcpPlanEntryView {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface AcpUsageView {
  used?: number;
  size?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  cost?: { amount: number; currency: string };
}

export interface AcpGoalView {
  objective: string;
  status: "active" | "paused" | "blocked" | "limited" | "complete";
  iterations?: number;
  lastReason?: string;
  createdAt?: number;
  updatedAt?: number;
  tokenBudget?: number;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

export interface AcpSessionFailureView {
  id: string;
  revision: number;
  category: string;
  severity: "warning" | "error";
  title: string;
  details?: string;
  actions: string[];
}

export type AcpFileChangeReportView =
  | {
      requestId: string;
      status: "reported";
      paths: string[];
      declaredComplete: boolean;
      truncated: boolean;
      uncertainty?: string;
    }
  | {
      requestId: string;
      status: "unavailable";
      reason: string;
    };

export type AcpContentView =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data?: string; uri?: string }
  | { type: "audio"; mimeType: string; data?: string }
  | { type: "resource"; uri: string; name?: string; title?: string; mimeType?: string; text?: string };

export type AcpToolContentView =
  | { type: "content"; content: AcpContentView }
  | { type: "diff"; path: string; oldText?: string; newText: string; truncated?: boolean }
  | { type: "terminal"; terminalId: string };

export interface AcpToolCallView {
  toolCallId: string;
  title: string;
  name?: string;
  kind: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
  status: "pending" | "in_progress" | "completed" | "failed";
  content: AcpToolContentView[];
  locations: Array<{ path: string; line?: number }>;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AcpTimelineItemView {
  id: string;
  at: string;
  kind: "user" | "agent" | "thought" | "tool" | "plan" | "status" | "error" | "usage" | "extension";
  title?: string;
  text?: string;
  messageId?: string;
  content?: AcpContentView;
  toolCall?: AcpToolCallView;
  plan?: AcpPlanEntryView[];
  usage?: AcpUsageView;
  extension?: { method: string; summary: string };
}

export interface AcpTerminalView {
  id: string;
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  state: "running" | "exited" | "released";
  output: string;
  truncated: boolean;
  exitCode?: number;
  signal?: string;
}

export interface AcpSubagentView {
  id: string;
  parentId?: string;
  name: string;
  task: string;
  state: "running" | "completed" | "failed" | "cancelled";
  timeline: AcpTimelineItemView[];
}

export interface AcpSessionView {
  id: string;
  agentSessionId: string;
  agent: AcpAgentId;
  title: string;
  cwd: string;
  additionalDirectories: string[];
  state: AcpSessionState;
  createdAt: string;
  updatedAt: string;
  lastStopReason?: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
  error?: string;
  modes?: AcpModeStateView;
  configOptions: AcpConfigOptionView[];
  availableCommands: AcpAvailableCommandView[];
  plan: AcpPlanEntryView[];
  usage?: AcpUsageView;
  goal?: AcpGoalView;
  failures: AcpSessionFailureView[];
  fileChangeReports: AcpFileChangeReportView[];
  timeline: AcpTimelineItemView[];
  terminals: AcpTerminalView[];
  subagents: AcpSubagentView[];
}

export interface AcpPermissionOptionView {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  description?: string;
}

export interface AcpInteractiveRequestView {
  id: string;
  agent: AcpAgentId;
  sessionId?: string;
  createdAt: string;
  kind: "permission" | "elicitation_form" | "elicitation_url";
  title: string;
  message?: string;
  toolCall?: AcpToolCallView;
  options?: AcpPermissionOptionView[];
  requestedSchema?: Record<string, unknown>;
  url?: string;
}

export interface AcpBridgeState {
  epoch: string;
  sequence: number;
  protocol: { version: 1; sdkVersion: string };
  agents: AcpAgentStatusView[];
  sessions: AcpSessionView[];
  requests: AcpInteractiveRequestView[];
}

export type AcpPromptBlockInput =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; uri?: string }
  | { type: "audio"; mimeType: string; data: string }
  | { type: "resource_link"; uri: string; name: string; title?: string; description?: string; mimeType?: string }
  | { type: "resource"; uri: string; text: string; mimeType?: string };
