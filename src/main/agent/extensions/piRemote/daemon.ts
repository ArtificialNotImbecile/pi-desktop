import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { PiRemoteError, asPiRemoteError } from "./errors.js";
import { withOwnedFileLock } from "./file-lock.js";
import { encodeJsonFrame, JsonFrameDecoder } from "./framing.js";
import {
  CONTROL_PROTOCOL_VERSION,
  RUNTIME_NODE_VERSION,
  RUNTIME_PI_VERSION,
  RUNTIME_VERSION,
  type PiRemoteControlMessage,
  type RemoteSessionEvent,
  type RuntimeInfo
} from "./types.js";

const MAX_RING_EVENTS = 10_000;
const MAX_RING_BYTES = 4 * 1024 * 1024;
const SELF_PROCESS_IDENTITY = randomUUID();
const IDLE_EXIT_MS = 15 * 60_000;

export interface HostPaths {
  remoteRoot: string;
  runtimeRoot: string;
  profileRoot: string;
  agentDir: string;
  sessionDir: string;
  logDir: string;
  runDir: string;
  socketPath: string;
  statusPath: string;
  descriptorDir: string;
  piExecutable: string;
  tmuxExecutable: string;
}

export interface DaemonOptions {
  profileId: string;
  paths: HostPaths;
  artifactSha256: string;
  logPath?: string;
}

type ClientRequest = Extract<PiRemoteControlMessage, { type: "request" }>;

interface RpcProcessState {
  process: ChildProcessWithoutNullStreams;
  stdinError?: Error;
  owner?: Socket;
  cwd: string;
  sessionId?: string;
  busy: boolean;
  agentActive: boolean;
  pendingTurnCommandIds: Set<string>;
  stdoutBuffer: string;
  stderrTail: string;
  startedAt: string;
  modeLeaseId: string;
  modeLeaseRelease: Promise<void>;
}

export class RemoteHostDaemon {
  private server?: Server;
  private readonly clients = new Set<Socket>();
  private readonly clientDecoders = new WeakMap<Socket, JsonFrameDecoder<PiRemoteControlMessage>>();
  private readonly events: Array<{ event: RemoteSessionEvent; bytes: number }> = [];
  private eventBytes = 0;
  private seq = 0;
  private rpc?: RpcProcessState;
  private idleTimer?: NodeJS.Timeout;
  private closing = false;
  private logStream?: WriteStream;

  constructor(private readonly options: DaemonOptions) {}

  async start(): Promise<void> {
    const { paths } = this.options;
    await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.logDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.sessionDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.descriptorDir, { recursive: true, mode: 0o700 });
    await rm(paths.socketPath, { force: true }).catch(() => {});
    this.logStream = createWriteStream(this.options.logPath ?? path.join(paths.logDir, "daemon.log"), { flags: "a", mode: 0o600 });
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.on("error", (error) => this.log("server-error", error));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(paths.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    await chmod(paths.socketPath, 0o600);
    await writeFile(paths.statusPath, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      processIdentity: await procStartTime(process.pid),
      profileId: this.options.profileId,
      socketPath: paths.socketPath,
      runtimeVersion: RUNTIME_VERSION,
      artifactSha256: this.options.artifactSha256,
      piVersion: RUNTIME_PI_VERSION,
      startedAt: new Date().toISOString()
    })}\n`, { encoding: "utf8", mode: 0o600 });
    this.armIdleTimer();
    this.log("started", { pid: process.pid });
  }

  async wait(): Promise<void> {
    if (!this.server) throw new Error("daemon is not started");
    await new Promise<void>((resolve) => this.server!.once("close", resolve));
  }

  async close(options: { abort?: boolean } = {}): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.rpc) await this.stopRpc(options.abort ?? true);
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await rm(this.options.paths.socketPath, { force: true }).catch(() => {});
    await rm(this.options.paths.statusPath, { force: true }).catch(() => {});
    this.log("stopped", {});
    this.logStream?.end();
  }

  private accept(socket: Socket): void {
    socket.setKeepAlive(true, 30_000);
    this.clients.add(socket);
    this.clientDecoders.set(socket, new JsonFrameDecoder<PiRemoteControlMessage>());
    socket.on("data", (chunk) => this.receive(socket, chunk));
    socket.once("close", () => {
      this.clients.delete(socket);
      if (this.rpc?.owner === socket) this.rpc.owner = undefined;
      this.armIdleTimer();
    });
    socket.once("error", (error) => this.log("client-error", error));
    this.armIdleTimer();
  }

  private receive(socket: Socket, chunk: Buffer): void {
    const decoder = this.clientDecoders.get(socket);
    if (!decoder) return;
    let messages: unknown[];
    try {
      messages = decoder.push(chunk) as unknown[];
    } catch (error) {
      this.rejectProtocolClient(socket, error);
      return;
    }
    for (const message of messages) {
      if (!isClientControlMessage(message)) {
        this.rejectProtocolClient(socket, new PiRemoteError("protocol-invalid", "Client control message is structurally invalid.", { phase: "protocol" }));
        return;
      }
      void this.handle(socket, message).catch((error) => this.rejectProtocolClient(socket, error));
    }
  }

  private async handle(socket: Socket, message: PiRemoteControlMessage): Promise<void> {
    if (message.type === "hello") {
      if (message.version !== CONTROL_PROTOCOL_VERSION) {
        this.sendError(socket, "protocol-version", new PiRemoteError("protocol-version", "Unsupported pi-remote control protocol version.", {
          phase: "protocol",
          safeDetails: { received: message.version, expected: CONTROL_PROTOCOL_VERSION }
        }));
        socket.end();
        return;
      }
      const hello: PiRemoteControlMessage = { type: "hello_ok", info: this.runtimeInfo(), seq: this.seq };
      socket.write(encodeJsonFrame(hello));
      const afterSeq = message.afterSeq ?? this.seq;
      for (const item of this.events) if (item.event.seq > afterSeq) socket.write(encodeJsonFrame({ type: "event", event: item.event }));
      return;
    }
    if (message.type !== "request") return;
    try {
      const result = await this.dispatch(message, socket);
      socket.write(encodeJsonFrame({ type: "response", id: message.id, ok: true, ...(result === undefined ? {} : { result }) }));
    } catch (error) {
      const normalized = asPiRemoteError(error, { code: "remote-request-failed", message: "Remote daemon request failed.", phase: "runtime" });
      socket.write(encodeJsonFrame({ type: "response", id: message.id, ok: false, error: normalized.serialize() }));
    }
  }

  private async dispatch(request: ClientRequest, socket: Socket): Promise<unknown> {
    switch (request.method) {
      case "runtime.info": return this.runtimeInfo();
      case "rpc.start": return this.startRpc(asObject(request.params), socket);
      case "rpc.bind_session": return this.bindRpcSession(asObject(request.params), socket);
      case "rpc.send": return this.sendRpc(asObject(request.params), socket);
      case "rpc.stop": return this.stopRpcForClient(socket, Boolean(asObject(request.params).abort ?? true));
      case "sessions.list": return listSessionMetadata(this.options.paths.sessionDir);
      case "daemon.stop": {
        setTimeout(() => void this.close({ abort: true }), 25).unref();
        return { stopping: true };
      }
      default:
        throw new PiRemoteError("method-not-supported", `Remote daemon method ${request.method} is not supported.`, { phase: "protocol" });
    }
  }

  private async startRpc(params: Record<string, unknown>, socket: Socket): Promise<{ started: boolean; cwd: string; sessionId?: string }> {
    const cwd = requiredAbsolutePath(params.cwd, "cwd");
    const cwdStat = await stat(cwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      throw new PiRemoteError("cwd-missing", `Remote working directory ${cwd} does not exist.`, {
        phase: "session",
        remediation: "Create the directory on the remote host or configure an existing profile cwd."
      });
    }
    const sessionId = optionalSessionId(params.sessionId);
    if (this.rpc) {
      if (this.rpc.owner && this.rpc.owner !== socket) {
        throw new PiRemoteError("rpc-lease-conflict", "Another connected client owns the active RPC runtime.", { phase: "session", retryable: true });
      }
      if (rpcLaunchMatches(this.rpc, { cwd, sessionId })) {
        this.rpc.owner = socket;
        return { started: false, cwd, ...(sessionId ? { sessionId } : {}) };
      }
      if (this.rpc.busy) {
        throw new PiRemoteError("rpc-session-busy", "The active remote session is still running a turn and cannot be switched safely.", {
          phase: "session",
          retryable: true,
          safeDetails: { activeSessionId: this.rpc.sessionId ?? null, requestedSessionId: sessionId ?? null }
        });
      }
      await this.stopRpc(false);
    }
    const piArgs = Array.isArray(params.piArgs) ? params.piArgs.map((value) => String(value)) : [];
    const env = runtimeEnvironment(this.options.paths, params.proxy as Record<string, unknown> | undefined);
    const modeLeaseId = randomUUID();
    await acquireSessionMode(this.options.paths, "rpc", modeLeaseId);
    if (socket.destroyed) {
      await releaseSessionMode(this.options.paths, modeLeaseId);
      throw new PiRemoteError("daemon-disconnected", "RPC startup client disconnected before the remote process was launched.", { phase: "session", retryable: true });
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.paths.piExecutable, ["--mode", "rpc", "--tui-mode", "fullscreen", ...piArgs], {
        cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      await releaseSessionMode(this.options.paths, modeLeaseId);
      throw error;
    }
    const state: RpcProcessState = {
      process: child, owner: socket, cwd, ...(sessionId ? { sessionId } : {}),
      busy: false, agentActive: false, pendingTurnCommandIds: new Set(),
      stdoutBuffer: "", stderrTail: "", startedAt: new Date().toISOString(), modeLeaseId, modeLeaseRelease: Promise.resolve()
    };
    this.rpc = state;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receiveRpcStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      if (!this.rpc) return;
      this.rpc.stderrTail = `${this.rpc.stderrTail}${chunk}`.slice(-16_384);
    });
    child.stdin.on("error", (error) => {
      state.stdinError = error;
      this.publish("rpc.error", { message: error.message });
    });
    let terminal = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminal) return;
      terminal = true;
      const stderr = state.stderrTail;
      if (this.rpc === state) this.rpc = undefined;
      state.modeLeaseRelease = releaseSessionMode(this.options.paths, state.modeLeaseId);
      this.publish("rpc.exit", { code, signal, diagnostic: redactRuntimeDiagnostic(stderr) });
      this.armIdleTimer();
    };
    child.once("exit", finish);
    child.once("close", finish);
    child.once("error", (error) => this.publish("rpc.error", { message: error.message }));
    this.publish("rpc.started", { cwd, sessionId: sessionId ?? null, pid: child.pid ?? null });
    return { started: true, cwd, ...(sessionId ? { sessionId } : {}) };
  }

  private bindRpcSession(params: Record<string, unknown>, socket: Socket): { bound: true; sessionId: string } {
    if (!this.rpc) throw new PiRemoteError("rpc-not-running", "No headless Pi RPC runtime is active.", { phase: "session" });
    this.requireRpcOwner(socket);
    const sessionId = optionalSessionId(params.sessionId);
    if (!sessionId) throw new PiRemoteError("session-id-invalid", "sessionId is required.", { phase: "session" });
    this.rpc.sessionId = sessionId;
    return { bound: true, sessionId };
  }

  private async sendRpc(params: Record<string, unknown>, socket: Socket): Promise<{ accepted: true }> {
    if (!this.rpc) throw new PiRemoteError("rpc-not-running", "No headless Pi RPC runtime is active.", { phase: "session" });
    this.requireRpcOwner(socket);
    const state = this.rpc;
    const command = params.command;
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new PiRemoteError("rpc-command-invalid", "RPC command must be an object.", { phase: "protocol" });
    }
    const commandRecord = command as Record<string, unknown>;
    const commandType = String(commandRecord.type ?? "");
    if (commandType === "prompt" || commandType === "steer" || commandType === "follow_up") {
      if (typeof commandRecord.id !== "string" || commandRecord.id.length === 0 || commandRecord.id.length > 128) {
        throw new PiRemoteError("rpc-command-invalid", "Turn-starting RPC commands require a bounded string id.", { phase: "protocol" });
      }
      state.pendingTurnCommandIds.add(commandRecord.id);
      state.busy = true;
    }
    const line = `${JSON.stringify(command)}\n`;
    try {
      if (state.stdinError) throw rpcInputError(state.stdinError);
      await writeRpcInput(state.process, line);
      return { accepted: true };
    } catch (error) {
      if (typeof commandRecord.id === "string" && state.pendingTurnCommandIds.delete(commandRecord.id)) refreshRpcBusy(state);
      throw error;
    }
  }

  private async stopRpc(abort: boolean): Promise<void> {
    const state = this.rpc;
    if (!state) return;
    const exited = new Promise<void>((resolve) => state.process.once("close", () => resolve()));
    if (abort) {
      await writeRpcInput(state.process, `${JSON.stringify({ id: `stop-${randomUUID()}`, type: "abort" })}\n`).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    state.process.stdin.end();
    const timer = setTimeout(() => state.process.kill("SIGTERM"), 2_000);
    timer.unref();
    await exited;
    await state.modeLeaseRelease;
    clearTimeout(timer);
  }

  private async stopRpcForClient(socket: Socket, abort: boolean): Promise<void> {
    if (!this.rpc) return;
    this.requireRpcOwner(socket);
    await this.stopRpc(abort);
  }

  private requireRpcOwner(socket: Socket): void {
    if (this.rpc?.owner !== socket) throw new PiRemoteError("rpc-lease-conflict", "This client does not own the active RPC runtime.", { phase: "session", retryable: true });
  }

  private receiveRpcStdout(chunk: string): void {
    if (!this.rpc) return;
    this.rpc.stdoutBuffer += chunk;
    while (true) {
      const newline = this.rpc.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.rpc.stdoutBuffer.slice(0, newline);
      this.rpc.stdoutBuffer = this.rpc.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.type === "agent_start") {
          this.rpc.agentActive = true;
          this.rpc.pendingTurnCommandIds.clear();
          this.rpc.busy = true;
        } else if (message.type === "agent_settled") {
          this.rpc.agentActive = false;
          this.rpc.pendingTurnCommandIds.clear();
          this.rpc.busy = false;
        } else if (message.type === "response" && message.success === false && typeof message.id === "string"
          && this.rpc.pendingTurnCommandIds.delete(message.id)) {
          refreshRpcBusy(this.rpc);
        }
        this.publish("rpc.message", message);
      } catch {
        this.publish("rpc.protocol_error", { diagnostic: redactRuntimeDiagnostic(line.slice(0, 500)) });
      }
    }
  }

  private publish(type: string, data?: unknown): void {
    const event: RemoteSessionEvent = { seq: ++this.seq, type, ...(data === undefined ? {} : { data }) };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    this.events.push({ event, bytes });
    this.eventBytes += bytes;
    while (this.events.length > MAX_RING_EVENTS || this.eventBytes > MAX_RING_BYTES) {
      const removed = this.events.shift();
      if (removed) this.eventBytes -= removed.bytes;
    }
    const frame = encodeJsonFrame({ type: "event", event });
    for (const client of this.clients) if (!client.destroyed) client.write(frame);
  }

  private runtimeInfo(): RuntimeInfo {
    const { paths } = this.options;
    return {
      controlVersion: CONTROL_PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      piVersion: RUNTIME_PI_VERSION,
      nodeVersion: RUNTIME_NODE_VERSION,
      platform: "linux",
      arch: "x64",
      artifactSha256: this.options.artifactSha256,
      capabilities: [
        "native-tui", "rpc-jsonl", "session-list", "prompt-text", "prompt-image", "steer", "follow-up",
        "abort", "model", "thinking", "tree", "fork", "clone", "compact", "extension-ui", "client-proxy"
      ],
      remoteRoot: paths.remoteRoot,
      profileRoot: paths.profileRoot,
      sessionRoot: paths.sessionDir
    };
  }

  private sendError(socket: Socket, id: string, error: unknown): void {
    const normalized = asPiRemoteError(error, { code: "protocol-invalid", message: "Invalid control protocol data.", phase: "protocol" });
    socket.write(encodeJsonFrame({ type: "response", id, ok: false, error: normalized.serialize() }));
  }

  private rejectProtocolClient(socket: Socket, error: unknown): void {
    try { this.sendError(socket, "protocol-invalid", error); } catch { /* a broken client may reject its final error frame */ }
    socket.destroy();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.clients.size > 0 || this.rpc) return;
    this.idleTimer = setTimeout(() => void this.close({ abort: false }), IDLE_EXIT_MS);
    this.idleTimer.unref();
  }

  private log(type: string, value: unknown): void {
    const safe = value instanceof Error ? { name: value.name, message: redactRuntimeDiagnostic(value.message) } : value;
    this.logStream?.write(`${JSON.stringify({ timestamp: new Date().toISOString(), type, data: safe })}\n`);
  }
}

function isClientControlMessage(value: unknown): value is Extract<PiRemoteControlMessage, { type: "hello" | "request" }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type === "hello") {
    return Number.isInteger(message.version)
      && typeof message.clientId === "string" && message.clientId.length > 0 && message.clientId.length <= 128
      && (message.afterSeq === undefined || Number.isInteger(message.afterSeq) && Number(message.afterSeq) >= 0);
  }
  if (message.type === "request") {
    return typeof message.id === "string" && message.id.length > 0 && message.id.length <= 128
      && typeof message.method === "string" && message.method.length > 0 && message.method.length <= 128;
  }
  return false;
}

function refreshRpcBusy(state: Pick<RpcProcessState, "busy" | "agentActive" | "pendingTurnCommandIds">): void {
  state.busy = state.agentActive || state.pendingTurnCommandIds.size > 0;
}

export function rpcLaunchMatches(
  current: Pick<RpcProcessState, "cwd" | "sessionId">,
  requested: { cwd: string; sessionId?: string }
): boolean {
  return current.cwd === requested.cwd && current.sessionId === requested.sessionId;
}

export function waitForRpcDrain(process: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off("drain", onDrain);
      process.stdin.off("error", onInputError);
      process.off("close", onClose);
      process.off("error", onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new PiRemoteError("rpc-process-closed", "Remote Pi RPC process closed while accepting a command.", { phase: "session", retryable: true })); };
    const onError = (error: Error) => { cleanup(); reject(new PiRemoteError("rpc-process-error", "Remote Pi RPC process failed while accepting a command.", { phase: "session", retryable: true, cause: error })); };
    const onInputError = (error: Error) => { cleanup(); reject(rpcInputError(error)); };
    process.stdin.once("drain", onDrain);
    process.stdin.once("error", onInputError);
    process.once("close", onClose);
    process.once("error", onError);
  });
}

export function writeRpcInput(process: ChildProcessWithoutNullStreams, input: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      process.stdin.off("error", onInputError);
      process.off("close", onClose);
      process.off("error", onProcessError);
    };
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(rpcInputError(error));
      else resolve();
    };
    const onInputError = (error: Error) => finish(error);
    const onClose = () => finish(new PiRemoteError("rpc-process-closed", "Remote Pi RPC process closed while accepting a command.", { phase: "session", retryable: true }));
    const onProcessError = (error: Error) => finish(error);
    process.stdin.once("error", onInputError);
    process.once("close", onClose);
    process.once("error", onProcessError);
    try { process.stdin.write(input, (error?: Error | null) => finish(error)); }
    catch (error) { finish(error as Error); }
  });
}

function rpcInputError(cause: Error): PiRemoteError {
  if (cause instanceof PiRemoteError) return cause;
  return new PiRemoteError("rpc-process-error", "Remote Pi RPC process failed while accepting a command.", { phase: "session", retryable: true, cause });
}

export async function ensureHostPaths(remoteRoot: string, runtimeRoot: string, profileId: string): Promise<HostPaths> {
  if (!/^[0-9a-f-]{36}$/iu.test(profileId)) throw new PiRemoteError("profile-id-invalid", "Profile id is invalid.", { phase: "profile" });
  const profileRoot = path.join(remoteRoot, "profiles", profileId);
  const runBase = process.env.XDG_RUNTIME_DIR || path.join("/tmp", `pi-remote-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  const runDir = path.join(runBase, profileId.slice(0, 16));
  const paths: HostPaths = {
    remoteRoot,
    runtimeRoot,
    profileRoot,
    agentDir: path.join(profileRoot, "agent"),
    sessionDir: path.join(profileRoot, "sessions"),
    logDir: path.join(profileRoot, "logs"),
    descriptorDir: path.join(profileRoot, "run-descriptors"),
    runDir,
    socketPath: path.join(runDir, "daemon.sock"),
    statusPath: path.join(runDir, "status.json"),
    piExecutable: path.join(runtimeRoot, "pi", "pi"),
    tmuxExecutable: path.join(runtimeRoot, "bin", "tmux")
  };
  await Promise.all([
    mkdir(paths.profileRoot, { recursive: true, mode: 0o700 }),
    mkdir(paths.runDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.descriptorDir, { recursive: true, mode: 0o700 })
  ]);
  return paths;
}

export async function daemonStatus(paths: HostPaths): Promise<{ running: boolean; pid?: number; runtimeVersion?: string; artifactSha256?: string }> {
  try {
    const parsed = JSON.parse(await readFile(paths.statusPath, "utf8")) as { pid?: number; processIdentity?: string; runtimeVersion?: string; artifactSha256?: string };
    if (!parsed.pid || !Number.isInteger(parsed.pid) || !parsed.processIdentity) return { running: false };
    try {
      process.kill(parsed.pid, 0);
      if (await procStartTime(parsed.pid) !== parsed.processIdentity) throw new Error("process identity mismatch");
      return { running: true, pid: parsed.pid, runtimeVersion: parsed.runtimeVersion, artifactSha256: parsed.artifactSha256 };
    } catch {
      await rm(paths.statusPath, { force: true }).catch(() => {});
      await rm(paths.socketPath, { force: true }).catch(() => {});
      return { running: false };
    }
  } catch {
    return { running: false };
  }
}

export async function acquireSessionMode(paths: HostPaths, mode: "rpc" | "tui", runId: string): Promise<void> {
  const target = path.join(paths.profileRoot, "session-mode.json");
  const guardPath = `${target}.acquire.lock`;
  await withOwnedFileLock(guardPath, async () => {
    const lease = await readFile(target, "utf8").then((raw) => JSON.parse(raw) as { pid?: number; processIdentity?: string }).catch((): { pid?: number; processIdentity?: string } => ({}));
    const live = lease.pid && lease.processIdentity
      ? await procStartTime(lease.pid).then((identity) => identity === lease.processIdentity).catch(() => false)
      : false;
    if (live) throw new PiRemoteError("session-mode-conflict", "Another Pi runtime mode is already active for this profile.", {
      phase: "session", retryable: true, remediation: "Reconnect to the active mode or run `pi-remote stop <profile>` first."
    });
    await rm(target, { force: true }).catch(() => {});
    const handle = await open(target, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify({ version: 1, mode, runId, pid: process.pid, processIdentity: await procStartTime(process.pid) })}\n`, "utf8"); }
    finally { await handle.close(); }
  }, {
    attempts: 100,
    pollMs: 25,
    timeoutCode: "session-mode-lock-timeout",
    timeoutMessage: "Timed out waiting for the runtime mode lock.",
    phase: "session"
  });
}

export async function refreshSessionModeOwner(paths: HostPaths, runId: string): Promise<void> {
  const target = path.join(paths.profileRoot, "session-mode.json");
  const current = await readFile(target, "utf8").then((raw) => JSON.parse(raw) as { version?: number; mode?: string; runId?: string });
  if (current.runId !== runId) throw new PiRemoteError("session-mode-conflict", "The active runtime mode lease changed before startup completed.", { phase: "session", retryable: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...current, pid: process.pid, processIdentity: await procStartTime(process.pid) })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

export async function releaseSessionMode(paths: HostPaths, runId: string): Promise<void> {
  const target = path.join(paths.profileRoot, "session-mode.json");
  const current = await readFile(target, "utf8").then((raw) => JSON.parse(raw) as { runId?: string }).catch((): { runId?: string } => ({}));
  if (current.runId === runId) await rm(target, { force: true }).catch(() => {});
}

async function procStartTime(pid: number): Promise<string> {
  let raw: string;
  try { raw = await readFile(`/proc/${pid}/stat`, "utf8"); }
  catch (error) {
    if (pid === process.pid) return SELF_PROCESS_IDENTITY;
    throw error;
  }
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const value = fields[19];
  if (!value) throw new Error("process start time unavailable");
  return value;
}

export async function storeRunDescriptor(paths: HostPaths, ticket: string, descriptor: unknown): Promise<void> {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(ticket)) throw new PiRemoteError("ticket-invalid", "Run ticket is invalid.", { phase: "protocol" });
  await mkdir(paths.descriptorDir, { recursive: true, mode: 0o700 });
  const target = path.join(paths.descriptorDir, `${ticket}.json`);
  const handle = await open(target, "wx", 0o600).catch((error) => {
    throw new PiRemoteError("ticket-exists", "Run ticket already exists.", { phase: "protocol", cause: error });
  });
  try {
    await handle.writeFile(`${JSON.stringify(descriptor)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function consumeRunDescriptor(paths: HostPaths, ticket: string): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(ticket)) throw new PiRemoteError("ticket-invalid", "Run ticket is invalid.", { phase: "protocol" });
  const target = path.join(paths.descriptorDir, `${ticket}.json`);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } finally {
    await rm(target, { force: true }).catch(() => {});
  }
  const value = JSON.parse(raw);
  return asObject(value);
}

export async function cleanupRunDescriptors(paths: HostPaths): Promise<void> {
  const now = Date.now();
  for (const entry of await readdir(paths.descriptorDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const target = path.join(paths.descriptorDir, entry.name);
    const info = await stat(target).catch(() => null);
    if (info && now - info.mtimeMs > 5 * 60_000) await rm(target, { force: true }).catch(() => {});
  }
}

export function runtimeEnvironment(paths: HostPaths, proxy?: Record<string, unknown>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.join(paths.runtimeRoot, "bin")}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
    PI_CODING_AGENT_DIR: paths.agentDir,
    PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
    PI_REMOTE_PROFILE_ROOT: paths.profileRoot,
    PI_REMOTE_RUNTIME: "1",
    PI_OFFLINE: "1"
  };
  if (proxy && proxy.url) {
    const url = String(proxy.url);
    env.HTTP_PROXY = env.http_proxy = url;
    env.HTTPS_PROXY = env.https_proxy = url;
    const noProxy = Array.isArray(proxy.noProxy) ? proxy.noProxy.map(String).join(",") : "localhost,127.0.0.1,::1";
    env.NO_PROXY = env.no_proxy = noProxy;
  }
  return env;
}

async function listSessionMetadata(sessionDir: string): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const info = await sessionMetadata(target);
        if (info) results.push(info);
      }
    }
  };
  await walk(sessionDir);
  return results.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

async function sessionMetadata(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const header = JSON.parse(lines[0] || "null") as Record<string, unknown> | null;
    if (!header || header.type !== "session" || typeof header.id !== "string") return null;
    let name: string | undefined;
    for (let index = lines.length - 1; index > 0; index -= 1) {
      const value = JSON.parse(lines[index]!) as Record<string, unknown>;
      if (value.type === "session_info" && typeof value.name === "string") { name = value.name; break; }
    }
    const fileStat = await stat(filePath);
    return {
      id: header.id,
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      createdAt: typeof header.timestamp === "string" ? header.timestamp : fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
      ...(name ? { name } : {})
    };
  } catch {
    return null;
  }
}

function requiredAbsolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new PiRemoteError(`${name}-invalid`, `${name} must be an absolute POSIX path.`, { phase: "session" });
  }
  return value;
}

function optionalSessionId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new PiRemoteError("session-id-invalid", "sessionId is invalid.", { phase: "session" });
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function redactRuntimeDiagnostic(value: string): string {
  return value
    .replace(/((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;"'}]+/giu, "$1<redacted>")
    .replace(/(authorization|proxy-authorization|api[-_ ]?key|token|secret)\s*[:=]\s*[^\s]+/giu, "$1=<redacted>")
    .replace(/https?:\/\/[^\s:@/]+:[^\s@/]+@/giu, "http://<redacted>@")
    .slice(0, 16_384);
}
