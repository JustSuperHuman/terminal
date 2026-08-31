import { fileURLToPath } from "node:url";

const MAX_OSC_BUFFER = 16 * 1024;

type ScanState = "ground" | "esc" | "osc" | "oscEsc" | "string" | "stringEsc";

interface SessionScanState {
  state: ScanState;
  oscBuffer: string;
  lastCwd?: string;
}

export interface WorkingDirectoryEvent {
  sessionId: string;
  cwd: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function cwdFromOsc(payload: string): string | undefined {
  if (payload.startsWith("7;")) {
    const value = payload.slice(2).trim();
    if (!value) {
      return undefined;
    }

    try {
      // OSC 7 is a file URI. fileURLToPath handles percent escapes, drive
      // letters, and UNC hosts without hand-rolled URL/path conversion.
      return value.toLowerCase().startsWith("file:") ? fileURLToPath(value) : undefined;
    } catch {
      return undefined;
    }
  }

  // ConEmu's OSC 9;9 form is what PowerShell and cmd commonly use on
  // Windows. The path may contain semicolons, so only remove the prefix.
  if (payload.startsWith("9;9;")) {
    const cwd = unquote(payload.slice(4));
    return cwd && !cwd.includes("\0") ? cwd : undefined;
  }

  return undefined;
}

// Tracks the same shell-integration sequences Windows Terminal uses for its
// own WorkingDirectory property. Parser state is kept per session because an
// OSC can be split across arbitrary PTY output chunks.
export class WorkingDirectoryDetector {
  private readonly sessions = new Map<string, SessionScanState>();

  constructor(private readonly onChange: (event: WorkingDirectoryEvent) => void) {}

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
          if (ch === "\x1b") {
            scan.state = "esc";
          }
          break;

        case "esc":
          if (ch === "]") {
            scan.state = "osc";
            scan.oscBuffer = "";
          } else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") {
            scan.state = "string";
          } else if (ch !== "\x1b") {
            scan.state = "ground";
          }
          break;

        case "osc":
          if (ch === "\x07") {
            this.emitOsc(sessionId, scan);
            scan.state = "ground";
          } else if (ch === "\x1b") {
            scan.state = "oscEsc";
          } else if (scan.oscBuffer.length < MAX_OSC_BUFFER) {
            scan.oscBuffer += ch;
          }
          break;

        case "oscEsc":
          if (ch === "\\") {
            this.emitOsc(sessionId, scan);
            scan.state = "ground";
          } else {
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

  private emitOsc(sessionId: string, scan: SessionScanState): void {
    const cwd = cwdFromOsc(scan.oscBuffer);
    if (!cwd || cwd === scan.lastCwd) {
      return;
    }

    scan.lastCwd = cwd;
    this.onChange({ sessionId, cwd });
  }
}
