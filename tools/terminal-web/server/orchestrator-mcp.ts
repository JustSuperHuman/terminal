// Stdio MCP server that gives the orchestrator agent (Claude Code or Codex)
// tools over every terminal session on this host, backed by the terminal-web
// HTTP API. Spawned by server/orchestrator.ts with TERMINAL_WEB_SERVER (and
// optionally TERMINAL_WEB_ACCESS_TOKEN) in the environment.
//
// Deliberately dependency-free (node stdlib + fetch) so it runs under tsx in
// dev, plain node from dist, or bun -- whatever launched the host server.

import process from "node:process";

const SERVER = (process.env.TERMINAL_WEB_SERVER ?? "http://127.0.0.1:10001").replace(/\/$/, "");
const TOKEN = process.env.TERMINAL_WEB_ACCESS_TOKEN;

const INSTRUCTIONS = [
  "terminal-web: tools over every terminal session on this machine (native Windows Terminal tabs plus web/mobile sessions).",
  "You are the host's Orchestrator. Typical work: summarize what sessions are doing, spot ones that are stuck or waiting, open/close/rename sessions, and drive the shells or AI agents running inside them.",
  "Etiquette: these are the user's real terminals. read_session before you type; never send destructive commands unless the user explicitly asked. After send_input, wait a moment and read_session again to confirm the effect. Other AI agents (Claude Code / Codex TUIs) respond to send_input like a person typing to them -- give them time, then read the session. Never type into or close the session marked isOrchestrator (that is you)."
].join("\n");

interface SessionSummary {
  id: string;
  title: string;
  status: string;
  cwd: string;
  projectId?: string;
  kind?: string;
  source: string;
  pid?: number;
  shell: string;
  createdAt: string;
  updatedAt: string;
}

async function api<T>(pathname: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (TOKEN) {
    headers.set("x-terminal-web-token", TOKEN);
  }
  const response = await fetch(`${SERVER}${pathname}`, { ...init, headers });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    let detail = "";
    try {
      detail = contentType.includes("json")
        ? Object.values((await response.json()) as Record<string, string>).join(" ")
        : (await response.text()).trim();
    } catch {
      detail = "";
    }
    throw new Error(`terminal-web ${pathname} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (contentType.includes("json") ? response.json() : response.text()) as Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function orchestratorSessionId(): Promise<string | undefined> {
  try {
    const status = await api<{ sessionId?: string }>("/api/orchestrator");
    return status.sessionId;
  } catch {
    return undefined;
  }
}

async function requireForeignSession(sessionId: string, action: string): Promise<void> {
  if ((await orchestratorSessionId()) === sessionId) {
    throw new Error(`Refusing to ${action} the orchestrator's own session.`);
  }
}

async function writeSession(sessionId: string, data: string): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data })
  });
}

const KEY_SEQUENCES: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  esc: "\x1b",
  escape: "\x1b",
  space: " ",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+l": "\x0c",
  "ctrl+r": "\x12",
  "ctrl+u": "\x15",
  "ctrl+z": "\x1a"
};

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>) => Promise<string>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "list_sessions",
    description:
      "List every terminal session on this host: id, title, status, cwd, project, what is running, and how long since it last printed output. Start here.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const [sessions, projects, ownId] = await Promise.all([
        api<SessionSummary[]>("/api/sessions"),
        api<Array<{ id: string; name: string }>>("/api/projects"),
        orchestratorSessionId()
      ]);
      const projectNames = new Map(projects.map((project) => [project.id, project.name]));
      const now = Date.now();
      return JSON.stringify(
        sessions.map((session) => ({
          id: session.id,
          title: session.title,
          status: session.status,
          cwd: session.cwd,
          project: session.projectId ? projectNames.get(session.projectId) : undefined,
          shell: session.shell.split(/[\\/]/).pop(),
          source: session.source,
          pid: session.pid,
          idleSeconds: Math.max(0, Math.round((now - new Date(session.updatedAt).getTime()) / 1000)),
          isOrchestrator: session.id === ownId || undefined
        })),
        undefined,
        2
      );
    }
  },
  {
    name: "read_session",
    description:
      "Read a session's terminal as plain text (the rendered screen plus recent scrollback). Use this to see what a session is doing before interacting with it.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id from list_sessions." },
        lines: { type: "number", description: "How many trailing lines to return (default 80, max 1000)." }
      },
      required: ["sessionId"],
      additionalProperties: false
    },
    run: async (args) => {
      const lines = Math.max(1, Math.min(Math.floor(Number(args.lines) || 80), 1000));
      const text = await api<string>(`/api/sessions/${encodeURIComponent(String(args.sessionId))}/text?tail=${lines}`);
      return text || "(the session has not printed anything yet)";
    }
  },
  {
    name: "send_input",
    description:
      "Type text into a session, optionally pressing Enter after it. Works for shells and for AI agent TUIs (Claude Code, Codex) -- to talk to an agent, send your message with submit=true, give it time to respond, then read_session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        text: { type: "string", description: "The text to type." },
        submit: { type: "boolean", description: "Press Enter after the text (default true)." }
      },
      required: ["sessionId", "text"],
      additionalProperties: false
    },
    run: async (args) => {
      const sessionId = String(args.sessionId);
      await requireForeignSession(sessionId, "send input to");
      const text = String(args.text);
      // Multi-line text goes in as a bracketed paste so TUIs treat it as one
      // block instead of executing each line.
      const payload = text.includes("\n") ? `\x1b[200~${text.replace(/\r\n/g, "\n")}\x1b[201~` : text;
      await writeSession(sessionId, payload);
      if (args.submit !== false) {
        await sleep(150);
        await writeSession(sessionId, "\r");
      }
      return `Sent ${text.length} chars to ${sessionId}${args.submit !== false ? " and pressed Enter" : ""}.`;
    }
  },
  {
    name: "send_keys",
    description:
      "Press named keys in a session, for driving prompts and TUIs. Supported: enter, tab, shift+tab, esc, space, backspace, up, down, left, right, home, end, pageup, pagedown, ctrl+c, ctrl+d, ctrl+l, ctrl+r, ctrl+u, ctrl+z.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        keys: { type: "array", items: { type: "string" }, description: "Keys pressed in order." }
      },
      required: ["sessionId", "keys"],
      additionalProperties: false
    },
    run: async (args) => {
      const sessionId = String(args.sessionId);
      await requireForeignSession(sessionId, "send keys to");
      const keys = Array.isArray(args.keys) ? args.keys.map((key: unknown) => String(key).toLowerCase()) : [];
      if (keys.length === 0) {
        throw new Error("keys must be a non-empty array.");
      }
      for (const key of keys) {
        const sequence = KEY_SEQUENCES[key];
        if (!sequence) {
          throw new Error(`Unknown key "${key}".`);
        }
        await writeSession(sessionId, sequence);
        await sleep(60);
      }
      return `Pressed ${keys.join(", ")} in ${sessionId}.`;
    }
  },
  {
    name: "create_session",
    description:
      "Open a new terminal session. By default it opens as a tab in the user's desktop Windows Terminal (falling back to a web-only session); pass desktop=false to force a web-only session. profileId comes from the host's profiles (e.g. pwsh, cmd, claude, codex).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        profileId: { type: "string", description: "Shell/agent profile id (e.g. pwsh, claude, codex)." },
        cwd: { type: "string", description: "Starting directory." },
        projectId: { type: "string", description: "Project to attach the session to." },
        desktop: { type: "boolean", description: "Open as a desktop terminal tab (default true)." }
      },
      additionalProperties: false
    },
    run: async (args) => {
      const session = await api<SessionSummary>("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: args.title,
          profileId: args.profileId,
          cwd: args.cwd,
          projectId: args.projectId,
          mode: args.desktop === false ? "managed" : undefined
        })
      });
      return JSON.stringify({ id: session.id, title: session.title, cwd: session.cwd, source: session.source }, undefined, 2);
    }
  },
  {
    name: "close_session",
    description: "Close a terminal session (kills its process). Confirm with the user before closing anything that looks busy.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false
    },
    run: async (args) => {
      const sessionId = String(args.sessionId);
      await requireForeignSession(sessionId, "close");
      await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      return `Closed ${sessionId}.`;
    }
  },
  {
    name: "rename_session",
    description: "Rename a terminal session's title.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, title: { type: "string" } },
      required: ["sessionId", "title"],
      additionalProperties: false
    },
    run: async (args) => {
      await api(`/api/sessions/${encodeURIComponent(String(args.sessionId))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: String(args.title) })
      });
      return `Renamed ${args.sessionId} to "${args.title}".`;
    }
  },
  {
    name: "list_projects",
    description: "List the project groupings (name + directory) sessions are organized under, including recently closed ones.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const [projects, recents] = await Promise.all([
        api<unknown[]>("/api/projects"),
        api<unknown[]>("/api/projects/recent").catch(() => [])
      ]);
      return JSON.stringify({ projects, recentlyClosed: recents }, undefined, 2);
    }
  },
  {
    name: "notify_user",
    description: "Send a notification (sound + toast) to the user's connected devices, e.g. when a task they asked you to watch finishes.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        sound: { type: "string", description: 'Optional sound name, e.g. "done".' }
      },
      required: ["title"],
      additionalProperties: false
    },
    run: async (args) => {
      await api("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: args.title, body: args.body, sound: args.sound ?? "done" })
      });
      return "Notification sent.";
    }
  }
];

// --- Minimal MCP over newline-delimited JSON-RPC on stdio ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: any;
}

function reply(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id: number | string, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const id = request.id;
  if (id === undefined) {
    return; // Notifications (e.g. notifications/initialized) need no reply.
  }

  switch (request.method) {
    case "initialize":
      reply(id, {
        protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "terminal-web", title: "Terminal Web Orchestrator", version: "1.0.0" },
        instructions: INSTRUCTIONS
      });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      });
      return;
    case "tools/call": {
      const tool = TOOLS.find((candidate) => candidate.name === request.params?.name);
      if (!tool) {
        replyError(id, -32602, `Unknown tool: ${String(request.params?.name)}`);
        return;
      }
      try {
        const text = await tool.run(request.params?.arguments ?? {});
        reply(id, { content: [{ type: "text", text }], isError: false });
      } catch (error) {
        reply(id, {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true
        });
      }
      return;
    }
    default:
      replyError(id, -32601, `Method not found: ${request.method}`);
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  let newline = buffered.indexOf("\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf("\n");
    if (!line) {
      continue;
    }
    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      if (typeof request?.method === "string") {
        void handleRequest(request);
      }
    } catch {
      // Ignore malformed lines; the client retries requests it cares about.
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
