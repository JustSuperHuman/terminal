import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { TerminalManager } from "./terminal-manager.js";
import type { OrchestratorAgent, OrchestratorStatus } from "./types.js";

// Injected into the agent as a system-prompt append (Claude) and repeated as
// the MCP server's `instructions` (which both Claude Code and Codex surface),
// so the role survives whichever channel the agent honors.
export const ORCHESTRATOR_ROLE = [
  "You are the Orchestrator for this machine's terminal host. You run in a dedicated side panel and your job is to watch, summarize, and drive every other terminal session on this host through the terminal-web MCP tools.",
  "Sessions are the user's real terminals (native Windows Terminal tabs and web/mobile sessions). Read before you type, and never run destructive commands in a session unless the user explicitly asked for that.",
  "Typical asks: summarize what every session is doing, flag sessions that are stuck or waiting for input, open new terminals in a project, close finished ones, and relay prompts to AI agents (Claude Code / Codex) running in other sessions.",
  "After sending input to a session, wait briefly and read the session again to confirm the effect before moving on. Keep your answers tight: state, activity, and anything that needs the user's attention."
].join("\n\n");

const MCP_CONFIG_FILE = ".terminal-web-orchestrator.mcp.json";

interface OrchestratorDeps {
  manager: TerminalManager;
  getPort: () => number;
  getToken: () => string | undefined;
}

interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function tomlString(value: string): string {
  // JSON string / string-array syntax is valid TOML, which is what
  // `codex -c key=value` parses values as.
  return JSON.stringify(value);
}

export class Orchestrator extends EventEmitter {
  private state: OrchestratorStatus["state"] = "stopped";
  private agent?: OrchestratorAgent;
  private sessionId?: string;
  private startedAt?: string;
  private lastExit?: OrchestratorStatus["lastExit"];
  private exitWaiters: Array<() => void> = [];

  constructor(private readonly deps: OrchestratorDeps) {
    super();

    deps.manager.on("exit", (event: { sessionId: string; exitCode?: number; signal?: number }) => {
      if (event.sessionId !== this.sessionId) {
        return;
      }
      this.state = "stopped";
      this.lastExit = { exitCode: event.exitCode, signal: event.signal, at: new Date().toISOString() };
      this.sessionId = undefined;
      this.startedAt = undefined;
      for (const resolve of this.exitWaiters.splice(0)) {
        resolve();
      }
      this.emit("status", this.status());
    });

    deps.manager.on("output", (event: { sessionId: string }) => {
      if (event.sessionId === this.sessionId && this.state === "starting") {
        this.state = "running";
        this.emit("status", this.status());
      }
    });
  }

  status(): OrchestratorStatus {
    return {
      state: this.state,
      agent: this.agent,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      lastExit: this.lastExit,
      availableAgents: this.availableAgents()
    };
  }

  availableAgents(): OrchestratorAgent[] {
    return (["claude", "codex"] as const).filter((agent) =>
      this.deps.manager.profiles.some((profile) => profile.id === agent)
    );
  }

  async start(agent: OrchestratorAgent, options: { restart?: boolean } = {}): Promise<OrchestratorStatus> {
    if (this.state !== "stopped") {
      if (this.agent === agent && !options.restart) {
        return this.status();
      }
      await this.stopAndWait();
    }

    const profile = this.deps.manager.profiles.find((candidate) => candidate.id === agent);
    if (!profile) {
      throw new Error(`The ${agent} CLI is not installed on this host.`);
    }

    const mcp = this.resolveMcpLaunch();
    const args = agent === "claude" ? this.claudeArgs(mcp) : this.codexArgs(mcp);
    const cwd = process.env.TERMINAL_WEB_ORCHESTRATOR_CWD ?? os.homedir();

    const session = this.deps.manager.createSession({
      title: "Orchestrator",
      shell: profile.shell,
      args,
      cwd,
      kind: "orchestrator",
      cols: 100,
      rows: 30
    });

    this.agent = agent;
    this.sessionId = session.id;
    this.startedAt = new Date().toISOString();
    this.state = "starting";
    this.lastExit = undefined;
    this.emit("status", this.status());
    return this.status();
  }

  async stop(): Promise<OrchestratorStatus> {
    await this.stopAndWait();
    return this.status();
  }

  private async stopAndWait(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) {
      return;
    }

    if (!this.deps.manager.getSession(sessionId)) {
      // Already pruned; no exit event will come.
      this.state = "stopped";
      this.sessionId = undefined;
      this.startedAt = undefined;
      this.emit("status", this.status());
      return;
    }

    const exited = new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve);
    });
    this.deps.manager.kill(sessionId);
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000).unref?.())]);
  }

  // The MCP sidecar is this package's own orchestrator-mcp module. In dev the
  // sibling file is TypeScript (run through tsx); from a compiled dist it is
  // plain JS and runs on node directly. Under bun either runs as-is.
  private resolveMcpLaunch(): McpLaunch {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tsScript = path.join(here, "orchestrator-mcp.ts");
    const jsScript = path.join(here, "orchestrator-mcp.js");
    const script = existsSync(tsScript) ? tsScript : jsScript;

    const env: Record<string, string> = {
      TERMINAL_WEB_SERVER: `http://127.0.0.1:${this.deps.getPort()}`
    };
    const token = this.deps.getToken();
    if (token) {
      env.TERMINAL_WEB_ACCESS_TOKEN = token;
    }

    const runningOnBun = path.basename(process.execPath).toLowerCase().startsWith("bun");
    if (script.endsWith(".js") || runningOnBun) {
      return { command: process.execPath, args: [script], env };
    }

    const tsxCli = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    return { command: process.execPath, args: [tsxCli, script], env };
  }

  private claudeArgs(mcp: McpLaunch): string[] {
    const configPath = path.resolve(process.cwd(), MCP_CONFIG_FILE);
    writeFileSync(
      configPath,
      `${JSON.stringify(
        { mcpServers: { "terminal-web": { command: mcp.command, args: mcp.args, env: mcp.env } } },
        undefined,
        2
      )}\n`
    );
    return ["--mcp-config", configPath, "--append-system-prompt", ORCHESTRATOR_ROLE];
  }

  private codexArgs(mcp: McpLaunch): string[] {
    const envTable = `{${Object.entries(mcp.env)
      .map(([key, value]) => `${key} = ${tomlString(value)}`)
      .join(", ")}}`;
    return [
      "-c",
      `mcp_servers.terminal_web.command=${tomlString(mcp.command)}`,
      "-c",
      `mcp_servers.terminal_web.args=${JSON.stringify(mcp.args)}`,
      "-c",
      `mcp_servers.terminal_web.env=${envTable}`
    ];
  }
}
