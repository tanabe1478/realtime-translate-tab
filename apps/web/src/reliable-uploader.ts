import { encodeAudioFrame, isServerEvent, type AudioFrameHeader, type ServerEvent } from "@realtime-translate/contracts";
import { ChunkStore } from "./chunk-store.js";

export type ConnectionState = "connecting" | "connected" | "offline" | "error";

export interface UploaderCallbacks {
  onEvent(event: ServerEvent): void;
  onConnectionState(state: ConnectionState): void;
  onPendingCount(count: number): void;
  onError(message: string): void;
}

export class ReliableUploader {
  private readonly store = new ChunkStore();
  private socket: WebSocket | null = null;
  private stopped = false;
  private serverReady = false;
  private blocked = false;
  private draining = false;
  private inFlightSeq: number | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private ackTimer: number | null = null;

  constructor(
    readonly sessionId: string,
    private readonly callbacks: UploaderCallbacks,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.reportPending();
    this.connect();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.clearAckTimer();
    this.socket?.close(1000, "client closed");
    this.socket = null;
  }

  async queue(header: AudioFrameHeader, audio: Blob): Promise<void> {
    if (header.sessionId !== this.sessionId) throw new Error("Uploader session mismatch");
    await this.store.put({
      sessionId: this.sessionId,
      seq: header.seq,
      header,
      audio,
      createdAt: new Date().toISOString(),
    });
    await this.reportPending();
    this.connect();
    await this.drain();
  }

  private connect(): void {
    if (this.stopped || this.blocked) return;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.callbacks.onConnectionState("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws?sessionId=${encodeURIComponent(this.sessionId)}`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.callbacks.onConnectionState("connected");
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => this.callbacks.onConnectionState("error");
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.serverReady = false;
      this.inFlightSeq = null;
      this.clearAckTimer();
      if (!this.stopped && !this.blocked) {
        this.callbacks.onConnectionState("offline");
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isServerEvent(value) || value.sessionId !== this.sessionId) return;
    this.callbacks.onEvent(value);

    if (value.type === "connected") {
      this.serverReady = true;
      void this.store.deleteThrough(this.sessionId, value.lastAckedSeq).then(async () => {
        await this.reportPending();
        await this.drain();
      });
      return;
    }

    if (value.type === "audio.ack") {
      if (this.inFlightSeq === value.seq) this.inFlightSeq = null;
      this.clearAckTimer();
      void this.store.delete(this.sessionId, value.seq).then(async () => {
        await this.reportPending();
        await this.drain();
      });
      return;
    }

    if (value.type === "audio.rejected") {
      this.inFlightSeq = null;
      this.clearAckTimer();
      this.callbacks.onError(`チャンク ${value.seq}: ${value.message}`);
      if (!value.retryable) {
        this.blocked = true;
        this.callbacks.onConnectionState("error");
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || this.blocked || !this.serverReady || this.inFlightSeq !== null || this.socket?.readyState !== WebSocket.OPEN) return;
    this.draining = true;
    try {
      const chunks = await this.store.list(this.sessionId);
      const next = chunks[0];
      if (!next || this.socket?.readyState !== WebSocket.OPEN || !this.serverReady) return;
      const bytes = await next.audio.arrayBuffer();
      this.inFlightSeq = next.seq;
      this.socket.send(encodeAudioFrame(next.header, bytes));
      this.ackTimer = window.setTimeout(() => {
        if (this.inFlightSeq === next.seq) this.socket?.close(4000, "ACK timeout");
      }, 15_000);
    } catch (error) {
      this.inFlightSeq = null;
      this.callbacks.onError(error instanceof Error ? error.message : String(error));
    } finally {
      this.draining = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.stopped) return;
    const delay = Math.min(10_000, 500 * 2 ** this.reconnectAttempt) + Math.random() * 250;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== null) window.clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private async reportPending(): Promise<void> {
    this.callbacks.onPendingCount(await this.store.count(this.sessionId));
  }
}
