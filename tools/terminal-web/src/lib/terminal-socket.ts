import type { ClientMessage, ServerMessage } from "./types";
import { getAccessToken } from "./access-token";

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: SocketStatus) => void;

export type SocketStatus = "connecting" | "open" | "closed";

class TerminalSocket {
  private socket?: WebSocket;
  private reconnectTimer?: number;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private status: SocketStatus = "closed";

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${window.location.host}/ws`);
    const token = getAccessToken();
    if (token) {
      url.searchParams.set("token", token);
    }
    this.socket = new WebSocket(url);

    this.socket.addEventListener("open", () => {
      this.setStatus("open");
    });

    this.socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        for (const listener of this.messageListeners) {
          listener(message);
        }
      } catch {
        // Ignore malformed server messages. The server also validates client messages.
      }
    });

    this.socket.addEventListener("close", () => {
      this.setStatus("closed");
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => this.connect(), 1200);
    });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: SocketStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}

export const terminalSocket = new TerminalSocket();
