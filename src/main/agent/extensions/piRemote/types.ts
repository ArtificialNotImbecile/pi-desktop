export const CONTROL_PROTOCOL_VERSION = 1;
export const RUNTIME_VERSION = "0.1.0";
export const RUNTIME_PI_VERSION = "0.84.2";
export const RUNTIME_NODE_VERSION = "bun-1.3.14-compiled";
export const DEFAULT_REMOTE_ROOT = "${XDG_DATA_HOME:-$HOME/.local/share}/pi-remote";
export const DEFAULT_MAX_FRAME_LENGTH = 8 * 1024 * 1024;

export type EgressMode = "remote-direct" | "client-proxy";

export interface ClientProxySettings {
  noProxy: string[];
  allowedPorts: number[];
  upstreamProxyEnv?: string;
}

export interface RemoteProfile {
  id: string;
  name: string;
  sshHost: string;
  sshPort?: number;
  defaultCwd?: string;
  remoteRoot?: string;
  network: {
    mode: EgressMode;
    clientProxy: ClientProxySettings;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ProfilesDocument {
  version: 1;
  profiles: RemoteProfile[];
}

export type DoctorCheckStatus = "pass" | "fail" | "warning" | "unknown";

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface DoctorReport {
  ok: boolean;
  profile: Pick<RemoteProfile, "id" | "name" | "sshHost">;
  checks: DoctorCheck[];
}

export interface RuntimeInfo {
  controlVersion: number;
  runtimeVersion: string;
  piVersion: string;
  nodeVersion: string;
  platform: "linux";
  arch: "x64";
  artifactSha256: string;
  capabilities: string[];
  remoteRoot: string;
  profileRoot: string;
  sessionRoot: string;
}

export interface RemoteSessionMetadata {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt?: string;
  name?: string;
}

export interface RemoteImageInput {
  data: string;
  mimeType: string;
}

export interface RemoteModelConfig {
  models: Record<string, unknown>;
  settings: Partial<Record<"defaultProvider" | "defaultModel" | "defaultThinkingLevel", string>>;
}

export interface RemoteSessionEvent {
  seq: number;
  type: string;
  data?: unknown;
}

export interface RemoteSessionPort {
  readonly capabilities: readonly string[];
  readonly sessionId?: string;
  readonly eventCursor: number;
  subscribe(listener: (event: RemoteSessionEvent) => void): () => void;
  listSessions(): Promise<RemoteSessionMetadata[]>;
  createSession(cwd: string): Promise<string>;
  openSession(sessionId: string): Promise<void>;
  prompt(text: string, images?: RemoteImageInput[]): Promise<void>;
  steer(text: string, images?: RemoteImageInput[]): Promise<void>;
  followUp(text: string, images?: RemoteImageInput[]): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinking(level: string): Promise<void>;
  compact(instructions?: string): Promise<unknown>;
  getTree(): Promise<unknown>;
  fork(entryId: string): Promise<unknown>;
  clone(): Promise<unknown>;
  bash(command: string): Promise<unknown>;
  respondToExtensionUi(id: string, value: unknown): Promise<void>;
  close(options?: { abort?: boolean }): Promise<void>;
}

export interface OpenTuiOptions {
  cwd?: string;
  continueSession?: boolean;
  resume?: boolean;
  sessionId?: string;
  piArgs?: string[];
}

export interface OpenSessionOptions {
  cwd?: string;
  sessionId?: string;
}

export interface RemoteRuntimeManager {
  doctor(profile: RemoteProfile): Promise<DoctorReport>;
  ensureRuntime(profile: RemoteProfile): Promise<RuntimeInfo>;
  listSessions(profile: RemoteProfile): Promise<RemoteSessionMetadata[]>;
  openTui(profile: RemoteProfile, options?: OpenTuiOptions): Promise<number>;
  openSession(profile: RemoteProfile, options?: OpenSessionOptions): Promise<RemoteSessionPort>;
  syncModelConfig(profile: RemoteProfile, config: RemoteModelConfig): Promise<Record<string, unknown>>;
  stop(profile: RemoteProfile, options?: { force?: boolean }): Promise<void>;
}

export interface ProxyAuditEvent {
  timestamp: string;
  host: string;
  resolvedAddress?: string;
  port: number;
  decision: "allow" | "deny";
  method: string;
  bytesUp?: number;
  bytesDown?: number;
  durationMs?: number;
  errorCode?: string;
}

export type PiRemoteControlMessage =
  | { type: "hello"; version: number; clientId: string; afterSeq?: number }
  | { type: "hello_ok"; info: RuntimeInfo; seq: number }
  | { type: "request"; id: string; method: string; params?: unknown }
  | { type: "response"; id: string; ok: true; result?: unknown }
  | { type: "response"; id: string; ok: false; error: SerializedPiRemoteError }
  | { type: "event"; event: RemoteSessionEvent };

export interface SerializedPiRemoteError {
  name: "PiRemoteError";
  code: string;
  message: string;
  phase: string;
  retryable: boolean;
  remediation?: string;
  safeDetails?: Record<string, string | number | boolean | null>;
}
