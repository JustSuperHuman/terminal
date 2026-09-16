import type { ClientMessage, ServerMessage } from "../types";
import type { ServerEndpoint } from "./endpoint";

export type SocketStatus = "idle" | "connecting" | "open" | "closed";

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: SocketStatus) => void;
type HelloMessage = Extract<ServerMessage, { type: "hello" }>;

const RECONNECT_DELAY_MS = 1200;
const CONNECT_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Single, reconnecting WebSocket to a Terminal Web host. Mirrors the web
 * client's terminal-socket, but the endpoint is configurable at runtime so the
 * phone can point at any reachable host.
 */
export class TerminalSocket {
  private socket?: WebSocket;
  private endpoint?: ServerEndpoint;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private healthTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private shouldReconnect = false;
  private status: SocketStatus = "idle";
  private lastHello?: HelloMessage;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();

  get currentEndpoint(): ServerEndpoint | undefined {
    return this.endpoint;
  }

  get currentStatus(): SocketStatus {
    return this.status;
  }

  configure(endpoint: ServerEndpoint): void {
    const changed = this.endpoint?.wsUrl !== endpoint.wsUrl;
    this.endpoint = endpoint;
    if (!changed) {
      return;
    }

    this.shouldReconnect = false;
    this.lastHello = undefined;
    this.closeCurrentSocket();
    this.setStatus("idle");
  }

  connect(): void {
    if (!this.endpoint) {
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.shouldReconnect = true;
    clearTimeout(this.reconnectTimer);
    this.setStatus("connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.endpoint.wsUrl);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    this.healthTimer = setTimeout(() => this.retry(), CONNECT_TIMEOUT_MS);

    // Wait for hello before accepting input or restoring subscriptions.
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "hello") {
          this.lastHello = message;
          this.reconnectAttempt = 0;
          clearTimeout(this.healthTimer);
          this.setStatus("open");
          this.scheduleHeartbeat();
        } else if (message.type === "pong") {
          this.scheduleHeartbeat();
          return;
        }
        for (const listener of this.messageListeners) {
          listener(message);
        }
      } catch {
        // ignore malformed frames; server also validates
      }
    };

    socket.onerror = () => {
      if (this.socket === socket) this.retry();
    };

    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.retry();
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.lastHello = undefined;
    this.closeCurrentSocket();
    this.setStatus("idle");
  }

  /** OS suspension can leave a WebSocket OPEN even though its network is gone. */
  resume(): void {
    if (!this.shouldReconnect) return;
    this.lastHello = undefined;
    this.closeCurrentSocket();
    this.connect();
  }

  private retry(): void {
    this.closeCurrentSocket();
    this.lastHello = undefined;
    this.setStatus("closed");
    if (this.shouldReconnect) {
      const delay = Math.min(15000, RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
  }

  private scheduleHeartbeat(): void {
    clearTimeout(this.healthTimer);
    // Old hosts remain compatible; foreground resume still repairs their sockets.
    if (!this.lastHello?.heartbeat) return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = setTimeout(() => this.retry(), CONNECT_TIMEOUT_MS);
      this.send({ type: "ping" });
    }, HEARTBEAT_INTERVAL_MS);
  }

  send(message: ClientMessage): boolean {
    if (this.status === "open" && this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(message));
        return true;
      } catch {
        this.retry();
      }
    }
    return false;
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    if (this.lastHello) {
      listener(this.lastHello);
    }
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  private closeCurrentSocket(): void {
    clearTimeout(this.healthTimer);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (!this.socket) {
      return;
    }

    this.socket.onclose = null;
    this.socket.onmessage = null;
    this.socket.onopen = null;
    this.socket.onerror = null;
    try {
      this.socket.close();
    } catch {
      // ignore
    }
    this.socket = undefined;
  }
}

export const terminalSocket = new TerminalSocket();
