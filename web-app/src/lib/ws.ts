import type { InspectResult } from "./types";

export type ClientMsg =
  | { type: "touch"; action: "down" | "up" | "move" | "tap"; x: number; y: number }
  | {
      type: "swipe";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      /** Seconds; default ~0.25 if omitted. */
      duration?: number;
    }
  | { type: "button"; button: string; direction?: "Down" | "Up" }
  | { type: "multitask" }
  | { type: "key"; keyCode: string; direction?: "Down" | "Up" }
  | { type: "type"; text: string }
  | { type: "inspect"; x: number; y: number; requestStack?: boolean; reqId?: string };

export type ServerMsg =
  | InspectResult
  | { type: "bridgeStatus"; status: "connected" | "disconnected" };

type Listener = (msg: ServerMsg) => void;

/**
 * Persistent WebSocket to the agent-simulator Node server.
 * Auto-reconnects with exponential backoff and provides a typed send/subscribe API.
 */
export class SimSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private openListeners = new Set<(open: boolean) => void>();
  private backoff = 500;
  private closed = false;

  constructor(private url: string) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.openListeners.forEach((l) => l(true));
    };
    ws.onclose = () => {
      this.openListeners.forEach((l) => l(false));
      if (this.closed) return;
      const wait = Math.min(this.backoff, 5000);
      this.backoff = Math.min(this.backoff * 2, 5000);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => {
      // onclose will fire after an error; let it drive reconnect
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.listeners.forEach((l) => l(msg));
    };
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMsg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onOpen(l: (open: boolean) => void) {
    this.openListeners.add(l);
    l(this.isOpen());
    return () => this.openListeners.delete(l);
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }
}
