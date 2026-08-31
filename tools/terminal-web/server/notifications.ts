import { randomBytes } from "node:crypto";
import type { TerminalNotification } from "./types.js";

const MAX_HISTORY = 200;
const MAX_OSC_BUFFER = 4096;

// Keeps the most recent notifications so clients that were disconnected or
// backgrounded (the mobile app loses its socket within seconds of leaving the
// foreground) can catch up on reconnect via GET /api/notifications.
export class NotificationCenter {
  private readonly history: TerminalNotification[] = [];

  record(partial: Omit<TerminalNotification, "id" | "at">): TerminalNotification {
    const notification: TerminalNotification = {
      id: randomBytes(8).toString("hex"),
      at: new Date().toISOString(),
      ...partial
    };
    this.history.push(notification);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    return notification;
  }

  list(sinceMs?: number): TerminalNotification[] {
    if (!Number.isFinite(sinceMs)) {
      return [...this.history];
    }
    return this.history.filter((notification) => Date.parse(notification.at) > (sinceMs as number));
  }
}

export interface BellEvent {
  sessionId: string;
  // "bell" is a bare BEL; "osc" carries an explicit notification payload
  // (OSC 9 message or OSC 777;notify;title;body).
  origin: "bell" | "osc";
  title?: string;
  body?: string;
}

type ScanState = "ground" | "esc" | "osc" | "oscEsc" | "string" | "stringEsc";

interface SessionScanState {
  state: ScanState;
  oscBuffer: string;
}

// Scans raw VT output for "the program wants attention" signals: a bare BEL
// (what Claude Code / Codex ring when a task finishes) and the explicit
// notification OSCs (9 and 777). A real parser state machine is required
// because BEL also terminates OSC strings — title updates like
// `ESC]0;title BEL` must NOT count as bells (that was every title change).
// State persists across chunks since escape sequences split at chunk edges.
export class BellDetector {
  private readonly sessions = new Map<string, SessionScanState>();

  constructor(private readonly onEvent: (event: BellEvent) => void) {}

  dispose(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  feed(sessionId: string, data: string): void {
    let scan = this.sessions.get(sessionId);
    if (!scan) {
      scan = { state: "ground", oscBuffer: "" };
      this.sessions.set(sessionId, scan);
    }

    for (let i = 0; i < data.length; i += 1) {
      const ch = data[i];

      switch (scan.state) {
        case "ground":
          if (ch === "\x07") {
            this.onEvent({ sessionId, origin: "bell" });
          } else if (ch === "\x1b") {
            scan.state = "esc";
          }
          break;

        case "esc":
          if (ch === "]") {
            scan.state = "osc";
            scan.oscBuffer = "";
          } else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") {
            // DCS/SOS/PM/APC: opaque string data until ST; BEL inside is content.
            scan.state = "string";
          } else if (ch === "\x1b") {
            scan.state = "esc";
          } else {
            // CSI and simple escapes never legally contain BEL; scanning
            // their bytes as ground is safe and keeps the machine small.
            scan.state = "ground";
          }
          break;

        case "osc":
          if (ch === "\x07") {
            this.emitOsc(sessionId, scan.oscBuffer);
            scan.state = "ground";
          } else if (ch === "\x1b") {
            scan.state = "oscEsc";
          } else if (scan.oscBuffer.length < MAX_OSC_BUFFER) {
            scan.oscBuffer += ch;
          }
          break;

        case "oscEsc":
          if (ch === "\\") {
            this.emitOsc(sessionId, scan.oscBuffer);
            scan.state = "ground";
          } else {
            // ESC + anything else aborts the OSC; reprocess as a fresh escape.
            scan.state = "esc";
            i -= 1;
          }
          break;

        case "string":
          if (ch === "\x1b") {
            scan.state = "stringEsc";
          }
          break;

        case "stringEsc":
          scan.state = ch === "\\" ? "ground" : "string";
          break;
      }
    }
  }

  private emitOsc(sessionId: string, payload: string): void {
    // OSC 9;9 is ConEmu/Windows shell integration for current-directory
    // updates, not a notification. Treating every `cd` as a task-finish bell
    // would make automatic project tracking extremely noisy.
    if (payload.startsWith("9;9;")) {
      return;
    }

    if (payload.startsWith("9;")) {
      const body = payload.slice(2).trim();
      if (body) {
        this.onEvent({ sessionId, origin: "osc", body });
      }
      return;
    }

    if (payload.startsWith("777;")) {
      const parts = payload.split(";");
      if (parts[1] === "notify") {
        const title = parts[2]?.trim();
        const body = parts.slice(3).join(";").trim();
        if (title || body) {
          this.onEvent({ sessionId, origin: "osc", title: title || undefined, body: body || undefined });
        }
      }
    }
  }
}
