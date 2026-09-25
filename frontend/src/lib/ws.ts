/**
 * WebSocket transport for the agent stream.
 *
 * Reconnects on its own (exponential backoff, capped), heartbeats so a dead socket is
 * noticed within ~20s, and reports sequence gaps. The gap check uses ``sessionSeq``, the
 * per-session counter: ``seq`` counts the whole server's output, so it moves whenever another
 * session is busy, and a client is never sent those frames — checking it reported loss that had
 * not happened.
 */

import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@/types/protocol";

export type SocketStatus = "connecting" | "open" | "closed";

/**
 * The `agent.run` frame minus its discriminant. Deriving it keeps the request a field-for-field
 * mirror of the protocol instead of a second copy that drifts whenever a frame gains a field.
 */
export type RunRequest = Omit<Extract<ClientMessage, { type: "agent.run" }>, "type">;

export interface OrbitalSocketHandlers {
  onMessage(message: ServerMessage): void;
  onStatus(status: SocketStatus): void;
  onNotice?(level: "info" | "warn", message: string): void;
}

const HEARTBEAT_MS = 20_000;
const BACKOFF_MIN_MS = 400;
const BACKOFF_MAX_MS = 6_000;

export class OrbitalSocket {
  private socket: WebSocket | null = null;
  private currentStatus: SocketStatus = "closed";
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private closedByUser = false;
  private lastSeq = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly handlers: OrbitalSocketHandlers,
  ) {}

  get status(): SocketStatus {
    return this.currentStatus;
  }

  connect(): void {
    if (this.socket && this.currentStatus !== "closed") return;
    this.closedByUser = false;
    this.setStatus("connecting");

    const url = `${this.baseUrl.replace(/^http/, "ws")}/ws`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (cause) {
      this.handlers.onNotice?.("warn", `WebSocket could not be created: ${String(cause)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.lastSeq = 0;
      this.setStatus("open");
      this.startHeartbeat();
    };
    socket.onmessage = (event: MessageEvent<string>) => this.handleFrame(event.data);
    socket.onerror = () => {
      // The close event that follows drives reconnection; nothing to do here.
    };
    socket.onclose = () => {
      this.stopHeartbeat();
      this.socket = null;
      this.setStatus("closed");
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  close(): void {
    this.closedByUser = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.setStatus("closed");
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.handlers.onNotice?.("warn", `Dropped ${message.type}: the socket is not open.`);
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  subscribe(sessionId: string): void {
    this.send({ type: "subscribe", sessionId });
  }

  runAgent(request: RunRequest): void {
    this.send({ type: "agent.run", ...request });
  }

  cancelAgent(sessionId: string): void {
    this.send({ type: "agent.cancel", sessionId });
  }

  exec(sessionId: string, commandId: string, command: string, cwd: string, timeout?: number | null): void {
    this.send({ type: "terminal.exec", sessionId, commandId, command, cwd, timeout: timeout ?? null });
  }

  watch(sessionId: string, root: string): void {
    this.send({ type: "files.watch", sessionId, root });
  }

  private handleFrame(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.handlers.onNotice?.("warn", "Dropped an unparseable frame from the backend.");
      return;
    }
    if (message.v !== PROTOCOL_VERSION) {
      this.handlers.onNotice?.(
        "warn",
        `Frame protocol v${String(message.v)} does not match the client's v${PROTOCOL_VERSION}.`,
      );
      return;
    }
    if (message.type === "pong") return;
    if (message.sessionSeq !== null && this.lastSeq !== 0 && message.sessionSeq > this.lastSeq + 1) {
      this.handlers.onNotice?.(
        "warn",
        `Missed ${message.sessionSeq - this.lastSeq - 1} frame(s); resynchronising session state.`,
      );
    }
    if (message.sessionSeq !== null) this.lastSeq = Math.max(this.lastSeq, message.sessionSeq);
    this.handlers.onMessage(message);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => this.send({ type: "ping" }), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    const delay = Math.min(BACKOFF_MIN_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(status: SocketStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.handlers.onStatus(status);
  }
}
