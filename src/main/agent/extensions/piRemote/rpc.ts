import { randomUUID } from "node:crypto";
import net, { type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { PiRemoteError } from "./errors.js";
import { encodeJsonFrame, JsonFrameDecoder } from "./framing.js";
import {
  CONTROL_PROTOCOL_VERSION,
  type PiRemoteControlMessage,
  type RemoteImageInput,
  type RemoteSessionEvent,
  type RemoteSessionMetadata,
  type RemoteSessionPort,
  type RuntimeInfo
} from "./types.js";

type RequestMessage = Extract<PiRemoteControlMessage, { type: "request" }>;
type ResponseMessage = Extract<PiRemoteControlMessage, { type: "response" }>;

export class DaemonClient {
  private socket?: Socket;
  private transport?: ControlTransport;
  private decoder = new JsonFrameDecoder<PiRemoteControlMessage>();
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private readonly listeners = new Set<(event: RemoteSessionEvent) => void>();
  private readonly bufferedEvents: RemoteSessionEvent[] = [];
  private readonly disconnectListeners = new Set<(error: unknown) => void>();
  private helloResolve?: (info: RuntimeInfo) => void;
  private helloReject?: (error: unknown) => void;
  private lastSeq = 0;
  private disconnectedState = false;
  runtimeInfo?: RuntimeInfo;

  constructor(private readonly target: string | ControlTransport) {}

  async connect(): Promise<RuntimeInfo> {
    if ((this.socket && !this.socket.destroyed || this.transport) && this.runtimeInfo) return this.runtimeInfo;
    this.decoder = new JsonFrameDecoder<PiRemoteControlMessage>();
    this.disconnectedState = false;
    let readable: Readable;
    let writable: Writable;
    if (typeof this.target === "string") {
      const socket = net.createConnection(this.target);
      this.socket = socket;
      readable = socket;
      writable = socket;
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    } else {
      this.transport = this.target;
      readable = this.target.readable;
      writable = this.target.writable;
    }
    readable.on("data", (chunk) => this.receive(Buffer.from(chunk)));
    readable.once("error", (error) => {
      this.rejectConnection(this.transportError(error));
    });
    writable.once("error", (error) => this.rejectConnection(this.transportError(error)));
    readable.once("close", () => this.rejectConnection(new PiRemoteError("daemon-disconnected", "Remote daemon connection closed.", {
      phase: "protocol", retryable: true
    })));
    const hello = new Promise<RuntimeInfo>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
    try {
      writable.write(encodeJsonFrame({
        type: "hello",
        version: CONTROL_PROTOCOL_VERSION,
        clientId: randomUUID(),
        afterSeq: this.lastSeq
      }));
    } catch (error) {
      this.rejectConnection(this.transportError(error));
    }
    return hello;
  }

  subscribe(listener: (event: RemoteSessionEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.bufferedEvents.length) {
      const replay = this.bufferedEvents.splice(0);
      for (const event of replay) {
        try { listener(event); } catch { /* replay observers are isolated */ }
      }
    }
    return () => this.listeners.delete(listener);
  }

  subscribeDisconnect(listener: (error: unknown) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const writable = this.transport?.writable ?? this.socket;
    if (this.disconnectedState || !writable || this.socket?.destroyed) throw new PiRemoteError("daemon-disconnected", "Remote daemon is not connected.", { phase: "protocol", retryable: true });
    const id = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const message: RequestMessage = { type: "request", id, method, ...(params === undefined ? {} : { params }) };
    try { writable.write(encodeJsonFrame(message)); }
    catch (error) { this.rejectConnection(this.transportError(error)); }
    return result;
  }

  close(): void {
    const socket = this.socket;
    const transport = this.transport;
    this.rejectConnection(new PiRemoteError("daemon-disconnected", "Remote daemon connection closed.", {
      phase: "protocol", retryable: true
    }));
    socket?.end();
    this.socket = undefined;
    transport?.close();
    this.transport = undefined;
  }

  private receive(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        if (message.type === "hello_ok") {
          this.runtimeInfo = message.info;
          this.lastSeq = Math.max(this.lastSeq, message.seq);
          this.helloResolve?.(message.info);
          this.helloResolve = undefined;
          this.helloReject = undefined;
        } else if (message.type === "response") {
          this.settle(message);
        } else if (message.type === "event") {
          this.lastSeq = Math.max(this.lastSeq, message.event.seq);
          if (this.listeners.size === 0) {
            this.bufferedEvents.push(message.event);
            if (this.bufferedEvents.length > 4096) this.bufferedEvents.shift();
          }
          for (const listener of this.listeners) {
            try { listener(message.event); } catch { /* listeners cannot corrupt protocol state */ }
          }
        }
      }
    } catch (error) {
      this.failTransport(error);
    }
  }

  private settle(message: ResponseMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(PiRemoteError.from(message.error));
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private rejectConnection(error: unknown): void {
    if (this.disconnectedState) return;
    this.disconnectedState = true;
    this.helloReject?.(error);
    this.helloResolve = undefined;
    this.helloReject = undefined;
    this.rejectAll(error);
    for (const listener of this.disconnectListeners) {
      try { listener(error); } catch { /* disconnect observers are isolated */ }
    }
  }

  private transportError(cause: unknown): PiRemoteError {
    return new PiRemoteError("daemon-disconnected", "Remote daemon transport failed.", { phase: "protocol", retryable: true, cause });
  }

  private failTransport(cause: unknown): void {
    this.rejectConnection(this.transportError(cause));
    const socket = this.socket;
    const transport = this.transport;
    this.socket = undefined;
    this.transport = undefined;
    socket?.destroy();
    try { transport?.close(); } catch { /* transport teardown cannot replace the protocol failure */ }
  }
}

export interface ControlTransport {
  readable: Readable;
  writable: Writable;
  close(): void;
}

export class PiRpcSessionPort implements RemoteSessionPort {
  readonly capabilities: readonly string[];
  sessionId?: string;
  private readonly listeners = new Set<(event: RemoteSessionEvent) => void>();
  private readonly bufferedEvents: RemoteSessionEvent[] = [];
  private readonly rpcPending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private unsubscribe?: () => void;
  private unsubscribeDisconnect?: () => void;
  private lastSeq = 0;

  get eventCursor(): number { return this.lastSeq; }

  constructor(
    private readonly client: DaemonClient,
    capabilities: readonly string[],
    private readonly proxy?: { url: string; noProxy: string[] }
  ) {
    this.capabilities = [...capabilities];
    this.unsubscribe = client.subscribe((event) => this.receive(event));
    this.unsubscribeDisconnect = client.subscribeDisconnect((error) => this.disconnected(error));
  }

  subscribe(listener: (event: RemoteSessionEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.bufferedEvents.length) {
      const replay = this.bufferedEvents.splice(0);
      for (const event of replay) {
        try { listener(event); } catch { /* replay observers are isolated */ }
      }
    }
    return () => this.listeners.delete(listener);
  }

  async listSessions(): Promise<RemoteSessionMetadata[]> {
    return await this.client.request("sessions.list") as RemoteSessionMetadata[];
  }

  async createSession(cwd: string): Promise<string> {
    await this.client.request("rpc.start", { cwd, ...(this.proxy ? { proxy: this.proxy } : {}) });
    await this.rpc({ type: "new_session" });
    const state = await this.rpc({ type: "get_state" }) as Record<string, unknown>;
    this.sessionId = extractSessionId(state);
    await this.client.request("rpc.bind_session", { sessionId: this.sessionId });
    return this.sessionId;
  }

  async openSession(sessionId: string): Promise<void> {
    const sessions = await this.listSessions();
    const session = resolveSessionMetadata(sessions, sessionId);
    await this.client.request("rpc.start", {
      cwd: session.cwd,
      sessionId: session.id,
      piArgs: ["--session", session.id],
      ...(this.proxy ? { proxy: this.proxy } : {})
    });
    this.sessionId = session.id;
  }

  prompt(text: string, images: RemoteImageInput[] = []): Promise<void> {
    return this.rpc({ type: "prompt", message: text, ...(images.length ? { images } : {}) }).then(() => undefined);
  }

  steer(text: string, images: RemoteImageInput[] = []): Promise<void> {
    return this.rpc({ type: "steer", message: text, ...(images.length ? { images } : {}) }).then(() => undefined);
  }

  followUp(text: string, images: RemoteImageInput[] = []): Promise<void> {
    return this.rpc({ type: "follow_up", message: text, ...(images.length ? { images } : {}) }).then(() => undefined);
  }

  abort(): Promise<void> { return this.rpc({ type: "abort" }).then(() => undefined); }
  setModel(provider: string, modelId: string): Promise<void> { return this.rpc({ type: "set_model", provider, modelId }).then(() => undefined); }
  setThinking(level: string): Promise<void> { return this.rpc({ type: "set_thinking_level", level }).then(() => undefined); }
  compact(instructions?: string): Promise<unknown> { return this.rpc({ type: "compact", ...(instructions ? { customInstructions: instructions } : {}) }); }
  getTree(): Promise<unknown> { return this.rpc({ type: "get_tree" }); }
  fork(entryId: string): Promise<unknown> { return this.rpc({ type: "fork", entryId }); }
  clone(): Promise<unknown> { return this.rpc({ type: "clone" }); }
  bash(command: string): Promise<unknown> { return this.rpc({ type: "bash", command }); }
  respondToExtensionUi(id: string, value: unknown): Promise<void> {
    return this.rpc({ type: "extension_ui_response", id, value }).then(() => undefined);
  }

  async close(options: { abort?: boolean } = {}): Promise<void> {
    if (options.abort) await this.abort().catch(() => {});
    await this.client.request("rpc.stop", { abort: options.abort ?? false }).catch(() => {});
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeDisconnect?.();
    this.unsubscribeDisconnect = undefined;
    this.client.close();
  }

  private async rpc(command: Record<string, unknown>): Promise<unknown> {
    const id = typeof command.id === "string" ? command.id : randomUUID();
    const message = { ...command, id };
    const result = new Promise<unknown>((resolve, reject) => this.rpcPending.set(id, { resolve, reject }));
    try {
      await this.client.request("rpc.send", { command: message });
    } catch (error) {
      this.rpcPending.get(id)?.reject(error);
      this.rpcPending.delete(id);
      void result.catch(() => {});
      throw error;
    }
    return result;
  }

  private receive(event: RemoteSessionEvent): void {
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    if (event.type === "rpc.message" && event.data && typeof event.data === "object") {
      const message = event.data as Record<string, unknown>;
      if (message.type === "response" && typeof message.id === "string") {
        const pending = this.rpcPending.get(message.id);
        if (pending) {
          this.rpcPending.delete(message.id);
          if (message.success === false) pending.reject(new PiRemoteError("pi-rpc-failed", String(message.error || "Pi RPC command failed."), { phase: "session" }));
          else pending.resolve(message.data);
        }
      }
    }
    if (event.type === "rpc.exit" || event.type === "rpc.error" || event.type === "rpc.protocol_error") {
      const error = new PiRemoteError("remote-process-exited", "Remote Pi RPC process exited before pending commands completed.", {
        phase: "session",
        retryable: true,
        safeDetails: { eventType: event.type }
      });
      for (const pending of this.rpcPending.values()) pending.reject(error);
      this.rpcPending.clear();
    }
    if (this.listeners.size === 0) {
      this.bufferedEvents.push(event);
      if (this.bufferedEvents.length > 4096) this.bufferedEvents.shift();
    }
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* observers are isolated */ }
    }
  }

  private disconnected(cause: unknown): void {
    const error = new PiRemoteError("daemon-disconnected", "Remote daemon connection closed before pending commands completed.", {
      phase: "protocol",
      retryable: true,
      cause
    });
    for (const pending of this.rpcPending.values()) pending.reject(error);
    this.rpcPending.clear();
    const event: RemoteSessionEvent = { seq: ++this.lastSeq, type: "transport.disconnected" };
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* observers are isolated */ }
    }
  }
}

export function resolveSessionMetadata<T extends { id: string }>(sessions: T[], requestedId: string): T {
  const exact = sessions.find((candidate) => candidate.id === requestedId);
  if (exact) return exact;
  const matches = sessions.filter((candidate) => candidate.id.startsWith(requestedId));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new PiRemoteError("session-id-ambiguous", `Remote session prefix ${requestedId} matches multiple sessions.`, {
      phase: "session",
      remediation: "Use a longer prefix or the full session ID.",
      safeDetails: { matches: matches.length }
    });
  }
  throw new PiRemoteError("session-not-found", `Remote session ${requestedId} was not found.`, { phase: "session" });
}

function extractSessionId(state: Record<string, unknown>): string {
  const data = state.data && typeof state.data === "object" ? state.data as Record<string, unknown> : state;
  const sessionId = data.sessionId;
  if (typeof sessionId !== "string" || !sessionId) throw new PiRemoteError("session-id-missing", "Pi RPC did not report a session id.", { phase: "session" });
  return sessionId;
}
