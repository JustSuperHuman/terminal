import { WebSocket } from "ws";
import { makePeerSessionTargetId, parsePeerSessionTargetId } from "./peer-targets.js";
import type { ClientMessage, ServerMessage, TerminalHostPeer, TerminalSessionSummary } from "./types.js";

type PeerMessage = Extract<ClientMessage, { type: "subscribe" | "input" | "resize" | "rename" | "kill" }>;

function send(client: WebSocket, message: ServerMessage): void {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(message));
  }
}

function toPeerWsUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function withCompositeId(session: TerminalSessionSummary, targetId: string): TerminalSessionSummary {
  return {
    ...session,
    id: targetId
  };
}

class ClientPeerConnection {
  private socket?: WebSocket;
  private readonly pending: string[] = [];
  private readonly targets = new Map<string, string>();

  constructor(
    private readonly client: WebSocket,
    private readonly peer: TerminalHostPeer
  ) {}

  subscribe(sessionId: string): void {
    this.ensureTarget(sessionId);
    this.post({
      type: "subscribe",
      sessionId
    });
  }

  forward(message: PeerMessage): void {
    const parsed = parsePeerSessionTargetId(message.sessionId);
    if (!parsed) {
      return;
    }

    if (message.type === "subscribe") {
      this.subscribe(parsed.sessionId);
      return;
    }

    this.ensureTarget(parsed.sessionId);
    const forwarded = {
      ...message,
      sessionId: parsed.sessionId
    };
    this.post(forwarded);
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.pending.length = 0;
    this.targets.clear();
  }

  private ensureSocket(): WebSocket {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSING && this.socket.readyState !== WebSocket.CLOSED) {
      return this.socket;
    }

    const socket = new WebSocket(toPeerWsUrl(this.peer.url));
    this.socket = socket;

    socket.on("open", () => {
      while (this.pending.length > 0 && socket.readyState === WebSocket.OPEN) {
        socket.send(this.pending.shift()!);
      }
    });

    socket.on("message", (raw) => {
      this.handlePeerMessage(raw.toString());
    });

    socket.on("error", (error) => {
      send(this.client, {
        type: "error",
        message: `Peer :${this.peer.server.port} connection failed.`,
        detail: error instanceof Error ? error.message : String(error)
      });
    });

    socket.on("close", () => {
      this.socket = undefined;
    });

    return socket;
  }

  private post(message: PeerMessage): void {
    const payload = JSON.stringify(message);
    const socket = this.ensureSocket();

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    } else {
      this.pending.push(payload);
    }
  }

  private ensureTarget(sessionId: string): string {
    const existing = this.targets.get(sessionId);
    if (existing) {
      return existing;
    }
    const targetId = makePeerSessionTargetId(this.peer.server.port, sessionId);
    this.targets.set(sessionId, targetId);
    return targetId;
  }

  private handlePeerMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    if (message.type === "snapshot") {
      const targetId = this.targets.get(message.sessionId);
      if (!targetId) {
        return;
      }
      send(this.client, {
        ...message,
        sessionId: targetId,
        session: withCompositeId(message.session, targetId)
      });
    }

    if (message.type === "session") {
      const targetId = this.targets.get(message.session.id);
      if (!targetId) {
        return;
      }
      send(this.client, {
        ...message,
        session: withCompositeId(message.session, targetId)
      });
    }

    if (message.type === "output") {
      const targetId = this.targets.get(message.sessionId);
      if (!targetId) {
        return;
      }
      send(this.client, {
        ...message,
        sessionId: targetId
      });
    }

    if (message.type === "exit") {
      const targetId = this.targets.get(message.sessionId);
      if (!targetId) {
        return;
      }
      send(this.client, {
        ...message,
        sessionId: targetId,
        session: withCompositeId(message.session, targetId)
      });
    }
  }
}

export class PeerProxy {
  private readonly connections = new WeakMap<WebSocket, Map<number, ClientPeerConnection>>();

  constructor(private readonly getPeers: () => TerminalHostPeer[]) {}

  isPeerTarget(sessionId: string): boolean {
    return Boolean(parsePeerSessionTargetId(sessionId));
  }

  forward(client: WebSocket, message: PeerMessage): void {
    const target = parsePeerSessionTargetId(message.sessionId);
    if (!target) {
      throw new Error(`Invalid peer session target: ${message.sessionId}`);
    }

    this.getConnection(client, target.port).forward(message);
  }

  dispose(client: WebSocket): void {
    const connections = this.connections.get(client);
    if (!connections) {
      return;
    }
    for (const connection of connections.values()) {
      connection.close();
    }
    connections.clear();
  }

  private getConnection(client: WebSocket, port: number): ClientPeerConnection {
    let connections = this.connections.get(client);
    if (!connections) {
      connections = new Map();
      this.connections.set(client, connections);
    }

    const existing = connections.get(port);
    if (existing) {
      return existing;
    }

    const peer = this.getPeers().find((candidate) => candidate.server.port === port);
    if (!peer) {
      throw new Error(`Peer terminal host :${port} is not discovered. Refresh host discovery and try again.`);
    }

    const connection = new ClientPeerConnection(client, peer);
    connections.set(port, connection);
    return connection;
  }
}
