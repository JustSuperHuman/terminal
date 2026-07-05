import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import * as pty from "node-pty";
import { WebSocket } from "ws";
import type { BridgeClientMessage, BridgeServerMessage, TerminalSessionSummary } from "../server/types.js";

interface BridgeOptions {
  server: string;
  title?: string;
  cwd: string;
  mirror: boolean;
  command: string;
  args: string[];
}

const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 5000;

// The bridge mirrors the child command's output to this terminal, so its own
// operational chatter (connection retries, server-side error frames) must not
// be written to stdout/stderr or it pollutes the shell. These reconnect quietly;
// set TERMINAL_WEB_BRIDGE_DEBUG=1 to surface them for troubleshooting.
function debugLog(message: string): void {
  if (process.env.TERMINAL_WEB_BRIDGE_DEBUG) {
    process.stderr.write(`${message}\n`);
  }
}

function makeId(): string {
  return `bridge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getDefaultCommand(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const pwsh = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    return {
      command: pwsh,
      args: ["-NoLogo"]
    };
  }

  return {
    command: process.env.SHELL ?? (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash"),
    args: ["-l"]
  };
}

function getPathEntries(): string[] {
  return (process.env.Path ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function commandCandidates(command: string): string[] {
  if (path.extname(command)) {
    return [command];
  }

  if (process.platform === "win32") {
    return (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
      .map((extension) => `${command}${extension.toLowerCase()}`);
  }

  return [command];
}

function resolveCommand(command: string): string {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }

  for (const entry of getPathEntries()) {
    for (const candidate of commandCandidates(command)) {
      const fullPath = path.join(entry, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return command;
}

function getOptionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) {
    return args[index + 1];
  }

  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseOptions(): BridgeOptions {
  const rawArgs = process.argv.slice(2);
  const commandSeparator = rawArgs.indexOf("--");
  const optionArgs = commandSeparator >= 0 ? rawArgs.slice(0, commandSeparator) : rawArgs;
  const commandArgs = commandSeparator >= 0 ? rawArgs.slice(commandSeparator + 1) : [];
  const fallback = getDefaultCommand();

  return {
    server: getOptionValue(optionArgs, "--server") ?? process.env.TERMINAL_WEB_SERVER ?? "http://127.0.0.1:10001",
    title: getOptionValue(optionArgs, "--title"),
    cwd: getOptionValue(optionArgs, "--cwd") ?? process.cwd(),
    mirror: !optionArgs.includes("--no-mirror"),
    command: resolveCommand(commandArgs[0] ?? fallback.command),
    args: commandArgs.length > 0 ? commandArgs.slice(1) : fallback.args
  };
}

function toBridgeWsUrl(server: string): string {
  const parsed = new URL(server);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/bridge";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function send(socket: WebSocket, message: BridgeClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function parseMessage(raw: WebSocket.RawData): BridgeServerMessage | undefined {
  try {
    const value = JSON.parse(raw.toString());
    if (typeof value?.type === "string") {
      return value as BridgeServerMessage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function getCols(): number {
  return Math.max(20, Math.min(process.stdout.columns || 120, 400));
}

function getRows(): number {
  return Math.max(8, Math.min(process.stdout.rows || 32, 200));
}

function restoreInput(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

class ReplayBuffer {
  private readonly chunks: string[] = [];
  private bytes = 0;

  append(data: string): void {
    this.chunks.push(data);
    this.bytes += Buffer.byteLength(data, "utf8");

    while (this.bytes > MAX_REPLAY_BYTES && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed) {
        this.bytes -= Buffer.byteLength(removed, "utf8");
      }
    }
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }

  values(): string[] {
    return [...this.chunks];
  }
}

function main(): void {
  const options = parseOptions();
  const sessionId = makeId();
  const createdAt = new Date().toISOString();
  const fullReplay = new ReplayBuffer();
  const pendingReplay = new ReplayBuffer();
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let registered = false;
  let terminalExited = false;

  let terminal: pty.IPty;
  try {
    terminal = pty.spawn(options.command, options.args, {
      name: "xterm-256color",
      cols: getCols(),
      rows: getRows(),
      cwd: options.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1"
      }
    });
  } catch (error) {
    restoreInput();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  function summary(): TerminalSessionSummary {
    return {
      id: sessionId,
      title: options.title?.trim() || path.basename(options.command),
      shell: options.command,
      args: options.args,
      cwd: options.cwd,
      source: "bridged",
      pid: terminal.pid,
      status: "running",
      createdAt,
      updatedAt: new Date().toISOString(),
      cols: getCols(),
      rows: getRows(),
      bufferedBytes: 0
    };
  }

  function sendToServer(message: BridgeClientMessage): boolean {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  function replay(chunks: string[]): void {
    for (const data of chunks) {
      sendToServer({ type: "output", sessionId, data });
    }
  }

  function resizeToHostTerminal(): void {
    const cols = getCols();
    const rows = getRows();
    terminal.resize(cols, rows);
    sendToServer({ type: "resize", sessionId, cols, rows });
  }

  function scheduleReconnect(): void {
    if (terminalExited || reconnectTimer) {
      return;
    }

    const delay = Math.min(INITIAL_RECONNECT_MS * 2 ** reconnectAttempt, MAX_RECONNECT_MS);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function connect(): void {
    if (terminalExited || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const nextSocket = new WebSocket(toBridgeWsUrl(options.server));
    socket = nextSocket;
    registered = false;

    nextSocket.on("open", () => {
      reconnectAttempt = 0;
      send(nextSocket, { type: "register", session: summary() });
    });

    nextSocket.on("message", (raw) => {
      const message = parseMessage(raw);
      if (!message) {
        return;
      }

      switch (message.type) {
        case "registered":
          if (message.session.id === sessionId) {
            registered = true;
            if (message.replay) {
              replay(fullReplay.values());
              pendingReplay.clear();
            } else {
              replay(pendingReplay.values());
              pendingReplay.clear();
            }
          }
          break;
        case "input":
          if (message.sessionId === sessionId) {
            terminal.write(message.data);
          }
          break;
        case "resize":
          if (message.sessionId === sessionId) {
            terminal.resize(message.cols, message.rows);
          }
          break;
        case "kill":
          if (message.sessionId === sessionId) {
            terminal.kill();
          }
          break;
        case "error":
          debugLog(message.detail ? `${message.message} ${message.detail}` : message.message);
          break;
      }
    });

    nextSocket.on("error", (error) => {
      registered = false;
      debugLog(error instanceof Error ? error.message : String(error));
      nextSocket.close();
    });

    nextSocket.on("close", () => {
      if (socket === nextSocket) {
        socket = undefined;
      }
      registered = false;
      scheduleReconnect();
    });
  }

  terminal.onData((data) => {
    fullReplay.append(data);
    if (options.mirror) {
      process.stdout.write(data);
    }
    if (registered && sendToServer({ type: "output", sessionId, data })) {
      return;
    }
    pendingReplay.append(data);
  });

  terminal.onExit(({ exitCode, signal }) => {
    terminalExited = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    sendToServer({ type: "exit", sessionId, exitCode, signal });
    restoreInput();
    setTimeout(() => {
      socket?.close();
      process.exit(exitCode ?? 0);
    }, 50).unref();
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      resizeToHostTerminal();
      terminal.write(data.toString("utf8"));
    });
  }

  if (process.stdout.isTTY) {
    process.stdout.on("resize", () => {
      resizeToHostTerminal();
    });
  }

  connect();

  process.on("SIGINT", () => {
    terminal.kill();
    restoreInput();
    socket?.close();
    process.exit(130);
  });
}

main();
