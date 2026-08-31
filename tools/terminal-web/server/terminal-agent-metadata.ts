import type { TerminalAgentActivity, TerminalAgentId, TerminalAgentSource } from "./types.js";

const MAX_OSC_BUFFER = 1024;
const TERMINAL_WEB_AGENT_PREFIX = "1337;TerminalWeb.Agent=";

export type TerminalAssistAgent = Extract<TerminalAgentId, "claude" | "codex">;

export interface TerminalAgentPresenceEvent {
  sessionId: string;
  agent: TerminalAssistAgent;
  state: "active" | "inactive";
}

export interface MutableTerminalAgentMetadata {
  baseAgent?: TerminalAgentId;
  baseAgentSource?: Exclude<TerminalAgentSource, "osc" | "screen">;
  runtimeAgent?: TerminalAssistAgent;
  /** Agent recognised from the rendered screen, for terminals launched by hand. */
  screenAgent?: TerminalAssistAgent;
  agentActivity?: TerminalAgentActivity;
}

/**
 * What the rendered screen currently says about a terminal.
 *
 * A shell that never launched an agent reports `agent: undefined`, which is
 * how a terminal stops being an agent terminal the moment the harness exits.
 */
export interface TerminalAgentObservation {
  agent?: TerminalAssistAgent;
  activity?: TerminalAgentActivity;
}

/**
 * Applies a screen observation. Returns true when a client-visible field moved,
 * so callers only broadcast on real transitions rather than every render.
 */
export function updateTerminalAgentObservation(
  metadata: MutableTerminalAgentMetadata,
  observation: TerminalAgentObservation
): boolean {
  const nextActivity = observation.agent ? observation.activity : undefined;
  if (metadata.screenAgent === observation.agent && metadata.agentActivity === nextActivity) {
    return false;
  }
  metadata.screenAgent = observation.agent;
  metadata.agentActivity = nextActivity;
  return true;
}

export function updateTerminalAgentPresence(
  metadata: MutableTerminalAgentMetadata,
  event: Omit<TerminalAgentPresenceEvent, "sessionId">
): boolean {
  const nextRuntimeAgent = event.state === "active" ? event.agent : undefined;
  if (event.state === "inactive" && metadata.runtimeAgent !== event.agent) {
    return false;
  }
  if (metadata.runtimeAgent === nextRuntimeAgent) {
    return false;
  }
  metadata.runtimeAgent = nextRuntimeAgent;
  return true;
}

/**
 * Resolves the agent a client should show, most-trusted signal first: the
 * wrapper's OSC handshake, then the live screen fingerprint, then the launch
 * command. Screen detection outranks the launch command because `pwsh` that
 * later ran `claude` is an agent terminal, and a `claude` tab that exited back
 * to its shell is not.
 */
export function terminalAgentSummaryMetadata(metadata: MutableTerminalAgentMetadata): {
  agent?: TerminalAgentId;
  agentSource?: TerminalAgentSource;
  agentActivity?: TerminalAgentActivity;
} {
  const agent = metadata.runtimeAgent ?? metadata.screenAgent ?? metadata.baseAgent;
  const agentSource: TerminalAgentSource | undefined = metadata.runtimeAgent
    ? "osc"
    : metadata.screenAgent
      ? "screen"
      : agent
        ? metadata.baseAgentSource
        : undefined;

  // Activity is only meaningful while the screen still shows that agent, and
  // is omitted entirely when unknown so summaries stay free of empty fields.
  const agentActivity = agent && metadata.screenAgent === agent ? metadata.agentActivity : undefined;
  return agentActivity ? { agent, agentSource, agentActivity } : { agent, agentSource };
}

type ScanState = "ground" | "esc" | "osc" | "oscEsc" | "string" | "stringEsc";

interface SessionScanState {
  state: ScanState;
  oscBuffer: string;
  oscOverflow: boolean;
  activeAgent?: TerminalAssistAgent;
}

/**
 * Classifies launch commands and named profiles without treating arbitrary
 * terminal output as trusted process identity. Runtime wrappers can override
 * this baseline through TerminalAgentMetadataDetector's narrow OSC envelope.
 */
export function inferTerminalAgent(label: string, commandLine: string): TerminalAgentId | undefined {
  const text = `${label} ${commandLine}`.toLowerCase();
  const before = String.raw`(?:^|[\s"'\\/;&|()])`;
  const after = String.raw`(?=$|[\s"';&|()])`;
  if (new RegExp(`${before}codex(?:\\.exe)?${after}`).test(text)) {
    return "codex";
  }
  if (new RegExp(`${before}(?:claude|clawd)(?:\\.exe)?${after}`).test(text)) {
    return "claude";
  }
  if (new RegExp(`${before}hermes(?:\\.exe)?${after}`).test(text)) {
    return "hermes";
  }
  return undefined;
}

export function isTerminalAgentId(value: unknown): value is TerminalAgentId {
  return value === "claude" || value === "codex" || value === "hermes";
}

function decodeAgentPresence(payload: string): Omit<TerminalAgentPresenceEvent, "sessionId"> | undefined {
  if (!payload.startsWith(TERMINAL_WEB_AGENT_PREFIX)) {
    return undefined;
  }

  const encoded = payload.slice(TERMINAL_WEB_AGENT_PREFIX.length);
  // Node's base64 decoder is intentionally permissive. Validate the transport
  // alphabet first so malformed or smuggled suffixes cannot be accepted.
  if (!encoded || encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") > 256) {
      return undefined;
    }

    const value = JSON.parse(decoded) as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    // The deliberately tiny envelope prevents wrappers from accidentally
    // sending config paths, account names, environment values, or secrets.
    if (keys.length !== 3 || keys[0] !== "agent" || keys[1] !== "state" || keys[2] !== "v") {
      return undefined;
    }
    if (value.v !== 1 || (value.agent !== "claude" && value.agent !== "codex")) {
      return undefined;
    }
    if (value.state !== "active" && value.state !== "inactive") {
      return undefined;
    }

    return { agent: value.agent, state: value.state };
  } catch {
    return undefined;
  }
}

/**
 * Scans raw terminal output for bro-cli's safe, TTY-only presence handshake:
 *
 *   OSC 1337;TerminalWeb.Agent=<base64url({v:1,agent,state})> ST
 *
 * Parser state is isolated per terminal and survives arbitrary chunk splits.
 * BEL termination is accepted as a defensive compatibility measure, although
 * emitters should use ST. Only provider presence is surfaced; this is Terminal
 * Assist metadata and must never be represented as an attached ACP session.
 */
export class TerminalAgentMetadataDetector {
  private readonly sessions = new Map<string, SessionScanState>();

  constructor(private readonly onChange: (event: TerminalAgentPresenceEvent) => void) {}

  dispose(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  feed(sessionId: string, data: string): void {
    let scan = this.sessions.get(sessionId);
    if (!scan) {
      scan = { state: "ground", oscBuffer: "", oscOverflow: false };
      this.sessions.set(sessionId, scan);
    }

    for (let index = 0; index < data.length; index += 1) {
      const character = data[index];

      switch (scan.state) {
        case "ground":
          if (character === "\x1b") scan.state = "esc";
          break;

        case "esc":
          if (character === "]") {
            scan.state = "osc";
            scan.oscBuffer = "";
            scan.oscOverflow = false;
          } else if (character === "P" || character === "X" || character === "^" || character === "_") {
            scan.state = "string";
          } else if (character !== "\x1b") {
            scan.state = "ground";
          }
          break;

        case "osc":
          if (character === "\x07") {
            this.emitOsc(sessionId, scan);
            scan.state = "ground";
          } else if (character === "\x1b") {
            scan.state = "oscEsc";
          } else if (scan.oscBuffer.length < MAX_OSC_BUFFER) {
            scan.oscBuffer += character;
          } else {
            scan.oscOverflow = true;
          }
          break;

        case "oscEsc":
          if (character === "\\") {
            this.emitOsc(sessionId, scan);
            scan.state = "ground";
          } else {
            // Abort this OSC and reprocess the current byte as a fresh escape.
            scan.state = "esc";
            index -= 1;
          }
          break;

        case "string":
          if (character === "\x1b") scan.state = "stringEsc";
          break;

        case "stringEsc":
          scan.state = character === "\\" ? "ground" : "string";
          break;
      }
    }
  }

  private emitOsc(sessionId: string, scan: SessionScanState): void {
    if (scan.oscOverflow) {
      return;
    }

    const event = decodeAgentPresence(scan.oscBuffer);
    if (!event) {
      return;
    }

    if (event.state === "active") {
      if (scan.activeAgent === event.agent) {
        return;
      }
      scan.activeAgent = event.agent;
      this.onChange({ sessionId, ...event });
      return;
    }

    // Ignore stale or unpaired clears so one foreground wrapper cannot clear
    // a newer provider that has already become active in the same terminal.
    if (scan.activeAgent !== event.agent) {
      return;
    }
    scan.activeAgent = undefined;
    this.onChange({ sessionId, ...event });
  }
}
