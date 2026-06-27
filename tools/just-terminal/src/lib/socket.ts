import type { ClientMessage, ServerMessage } from "../types";
import type { ServerEndpoint } from "./endpoint";

export type SocketStatus = "idle" | "connecting" | "open" | "closed";

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: SocketStatus) => void;
type HelloMessage = Extract<ServerMessage, { type: "hello" }>;

const RECONNECT_DELAY_MS = 1200;

/**
 * Single, reconnecting WebSocket to a Terminal Web host. Mirrors the web
 * client's terminal-socket, but the endpoint is configurable at runtime so the
 * phone can point at any reachable host.
 */
class TerminalSocket {
  private socket?: WebSocket;
  private endpoint?: ServerEndpoint;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
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

    const socket = new WebSocket(this.endpoint.wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket === socket) {
        this.setStatus("open");
      }
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === "hello") {
          this.lastHello = message;
        }
        for (const listener of this.messageListeners) {
          listener(message);
        }
      } catch {
        // ignore malformed frames; server also validates
      }
    };

    socket.onerror = () => {
      // onclose will follow and drive reconnect/status.
    };

    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.setStatus("closed");
      if (this.shouldReconnect) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.lastHello = undefined;
    this.closeCurrentSocket();
    this.setStatus("idle");
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
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
