import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiRemoteError } from "./errors.js";
import { withOwnedFileLock } from "./file-lock.js";
import type { EgressMode, ProfilesDocument, RemoteProfile } from "./types.js";

const PROFILE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const SSH_HOST = /^[^\s\0\r\n]+$/u;

export interface AddProfileInput {
  name: string;
  sshHost: string;
  sshPort?: number;
  defaultCwd?: string;
  remoteRoot?: string;
  networkMode?: EgressMode;
  noProxy?: string[];
  allowedPorts?: number[];
  upstreamProxyEnv?: string;
}

/**
 * Editable fields of an existing profile. `id` is never editable: remote state
 * lives under `profiles/<id>/`, so a new id would orphan every session, every
 * credential, and the runtime already installed for that profile.
 *
 * `networkMode` and `remoteRoot` are excluded for the same reason — they select
 * which isolated remote tree the profile owns. Changing egress mode is adding a
 * second profile, not editing this one.
 *
 * An explicit `null` clears an optional field; `undefined` leaves it untouched.
 */
export interface UpdateProfileInput {
  name?: string;
  sshHost?: string;
  sshPort?: number | null;
  defaultCwd?: string | null;
  noProxy?: string[];
  allowedPorts?: number[];
  upstreamProxyEnv?: string | null;
}

export function defaultProfilesPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.PI_REMOTE_CONFIG_PATH) return path.resolve(env.PI_REMOTE_CONFIG_PATH);
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Roaming");
    return path.join(appData, "pi-remote", "profiles.json");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "pi-remote", "profiles.json");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pi-remote", "profiles.json");
}

export class ProfileStore {
  readonly filePath: string;

  constructor(filePath = defaultProfilesPath()) {
    this.filePath = path.resolve(filePath);
  }

  async list(): Promise<RemoteProfile[]> {
    return (await this.read()).profiles.map(cloneProfile);
  }

  async get(nameOrId: string): Promise<RemoteProfile> {
    const normalized = nameOrId.trim().toLocaleLowerCase();
    const profile = (await this.read()).profiles.find((candidate) =>
      candidate.id.toLocaleLowerCase() === normalized || candidate.name.toLocaleLowerCase() === normalized);
    if (!profile) {
      throw new PiRemoteError("profile-not-found", `Remote profile ${JSON.stringify(nameOrId)} was not found.`, {
        phase: "profile",
        remediation: "Run `pi-remote profile list` or add the profile first."
      });
    }
    return cloneProfile(profile);
  }

  async add(input: AddProfileInput): Promise<RemoteProfile> {
    const name = validateProfileName(input.name);
    const sshHost = validateSshHost(input.sshHost);
    const sshPort = input.sshPort === undefined ? undefined : validateSshPort(input.sshPort);
    const defaultCwd = input.defaultCwd === undefined ? undefined : validateRemotePath(input.defaultCwd, "cwd");
    const remoteRoot = input.remoteRoot === undefined ? undefined : validateRemotePath(input.remoteRoot, "remote root");
    const noProxy = validateNoProxy(input.noProxy ?? []);
    const allowedPorts = validateAllowedPorts(input.allowedPorts ?? [80, 443]);
    const upstreamProxyEnv = input.upstreamProxyEnv === undefined
      ? undefined
      : validateEnvironmentName(input.upstreamProxyEnv);
    return this.withLock(async () => {
      const document = await this.read();
      if (document.profiles.some((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new PiRemoteError("profile-exists", `Remote profile ${JSON.stringify(name)} already exists.`, { phase: "profile" });
      }
      const now = new Date().toISOString();
      const profile: RemoteProfile = {
      id: randomUUID(),
      name,
      sshHost,
      ...(sshPort ? { sshPort } : {}),
      ...(defaultCwd ? { defaultCwd } : {}),
      ...(remoteRoot ? { remoteRoot } : {}),
      network: {
        mode: input.networkMode ?? "remote-direct",
        clientProxy: {
          noProxy,
          allowedPorts,
          ...(upstreamProxyEnv ? { upstreamProxyEnv } : {})
        }
      },
      createdAt: now,
      updatedAt: now
      };
      document.profiles.push(profile);
      await this.write(document);
      return cloneProfile(profile);
    });
  }

  async update(nameOrId: string, input: UpdateProfileInput): Promise<RemoteProfile> {
    const name = input.name === undefined ? undefined : validateProfileName(input.name);
    const sshHost = input.sshHost === undefined ? undefined : validateSshHost(input.sshHost);
    const sshPort = input.sshPort === undefined || input.sshPort === null ? input.sshPort : validateSshPort(input.sshPort);
    const defaultCwd = input.defaultCwd === undefined || input.defaultCwd === null
      ? input.defaultCwd
      : validateRemotePath(input.defaultCwd, "cwd");
    const noProxy = input.noProxy === undefined ? undefined : validateNoProxy(input.noProxy);
    const allowedPorts = input.allowedPorts === undefined ? undefined : validateAllowedPorts(input.allowedPorts);
    const upstreamProxyEnv = input.upstreamProxyEnv === undefined || input.upstreamProxyEnv === null
      ? input.upstreamProxyEnv
      : validateEnvironmentName(input.upstreamProxyEnv);
    return this.withLock(async () => {
      const document = await this.read();
      const normalized = nameOrId.trim().toLocaleLowerCase();
      const index = document.profiles.findIndex((candidate) =>
        candidate.id.toLocaleLowerCase() === normalized || candidate.name.toLocaleLowerCase() === normalized);
      if (index < 0) {
        throw new PiRemoteError("profile-not-found", `Remote profile ${JSON.stringify(nameOrId)} was not found.`, {
          phase: "profile",
          remediation: "Run `pi-remote profile list` or add the profile first."
        });
      }
      const current = document.profiles[index]!;
      if (name && document.profiles.some((candidate) =>
        candidate.id !== current.id && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new PiRemoteError("profile-exists", `Remote profile ${JSON.stringify(name)} already exists.`, { phase: "profile" });
      }
      const next: RemoteProfile = {
        id: current.id,
        name: name ?? current.name,
        sshHost: sshHost ?? current.sshHost,
        ...resolveOptional("sshPort", sshPort, current.sshPort),
        ...resolveOptional("defaultCwd", defaultCwd, current.defaultCwd),
        ...(current.remoteRoot ? { remoteRoot: current.remoteRoot } : {}),
        network: {
          mode: current.network.mode,
          clientProxy: {
            noProxy: noProxy ?? current.network.clientProxy.noProxy,
            allowedPorts: allowedPorts ?? current.network.clientProxy.allowedPorts,
            ...resolveOptional("upstreamProxyEnv", upstreamProxyEnv, current.network.clientProxy.upstreamProxyEnv)
          }
        },
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString()
      };
      document.profiles[index] = next;
      await this.write(document);
      return cloneProfile(next);
    });
  }

  async remove(nameOrId: string): Promise<RemoteProfile> {
    return this.withLock(async () => {
      const document = await this.read();
      const normalized = nameOrId.trim().toLocaleLowerCase();
      const index = document.profiles.findIndex((candidate) =>
        candidate.id.toLocaleLowerCase() === normalized || candidate.name.toLocaleLowerCase() === normalized);
      if (index < 0) throw new PiRemoteError("profile-not-found", `Remote profile ${JSON.stringify(nameOrId)} was not found.`, { phase: "profile" });
      const [removed] = document.profiles.splice(index, 1);
      await this.write(document);
      return cloneProfile(removed!);
    });
  }

  private async read(): Promise<ProfilesDocument> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: [] };
      throw new PiRemoteError("profile-read-failed", "Failed to read remote profiles.", {
        phase: "profile",
        safeDetails: { path: this.filePath },
        cause: error
      });
    }
    try {
      return parseProfilesDocument(JSON.parse(raw));
    } catch (error) {
      throw new PiRemoteError("profile-config-invalid", "Remote profile configuration is invalid.", {
        phase: "profile",
        safeDetails: { path: this.filePath },
        remediation: "Repair or move the profile file; it is never overwritten after a parse failure.",
        cause: error
      });
    }
  }

  private async write(document: ProfilesDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    return withOwnedFileLock(lockPath, run, {
      timeoutCode: "profile-lock-timeout",
      timeoutMessage: "Timed out waiting for the profile configuration lock.",
      phase: "profile"
    });
  }
}

export function validateProfileName(value: string): string {
  const normalized = value.trim();
  if (!PROFILE_NAME.test(normalized)) {
    throw new PiRemoteError("profile-name-invalid", "Profile names must be 1-64 letters, numbers, dot, underscore, or dash.", { phase: "profile" });
  }
  return normalized;
}

export function validateSshHost(value: string): string {
  const normalized = value.trim();
  if (!SSH_HOST.test(normalized) || normalized.startsWith("-")) {
    throw new PiRemoteError("ssh-host-invalid", "SSH host must be one concrete OpenSSH host token without whitespace or leading dash.", { phase: "profile" });
  }
  return normalized;
}

export function validateRemotePath(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith("/") || /[\0\r\n]/u.test(normalized)) {
    throw new PiRemoteError("remote-path-invalid", `Remote ${label} must be an absolute POSIX path without control characters.`, { phase: "profile" });
  }
  return normalized;
}

function validateNoProxy(values: string[]): string[] {
  return Array.from(new Set(values.map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    if (/[^A-Za-z0-9._:-]/u.test(entry) || entry === "*") {
      throw new PiRemoteError("no-proxy-invalid", `NO_PROXY entry ${JSON.stringify(entry)} is not an exact hostname or address.`, { phase: "profile" });
    }
    return entry;
  })));
}

function validateAllowedPorts(values: number[]): number[] {
  const ports = Array.from(new Set(values));
  if (ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new PiRemoteError("proxy-port-invalid", "Allowed proxy ports must be integers from 1 through 65535.", { phase: "profile" });
  }
  return ports.sort((a, b) => a - b);
}

function validateEnvironmentName(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized)) {
    throw new PiRemoteError("proxy-env-invalid", "Upstream proxy must reference an environment variable name, not a literal URL.", { phase: "profile" });
  }
  return normalized;
}

function validateSshPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new PiRemoteError("ssh-port-invalid", "SSH port must be an integer from 1 through 65535.", { phase: "profile" });
  }
  return value;
}

function parseProfilesDocument(value: unknown): ProfilesDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("profile root must be an object");
  const candidate = value as Partial<ProfilesDocument>;
  if (candidate.version !== 1 || !Array.isArray(candidate.profiles)) throw new TypeError("unsupported profile document");
  return {
    version: 1,
    profiles: candidate.profiles.map(parseProfile)
  };
}

function parseProfile(value: unknown): RemoteProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("profile must be an object");
  const profile = value as RemoteProfile;
  validateProfileName(profile.name);
  validateSshHost(profile.sshHost);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(profile.id)) throw new TypeError("invalid profile id");
  if (profile.sshPort !== undefined) validateSshPort(profile.sshPort);
  if (profile.defaultCwd !== undefined) validateRemotePath(profile.defaultCwd, "cwd");
  if (profile.remoteRoot !== undefined) validateRemotePath(profile.remoteRoot, "remote root");
  if (profile.network?.mode !== "remote-direct" && profile.network?.mode !== "client-proxy") throw new TypeError("invalid network mode");
  const noProxy = validateNoProxy(profile.network.clientProxy?.noProxy ?? []);
  const allowedPorts = validateAllowedPorts(profile.network.clientProxy?.allowedPorts ?? [80, 443]);
  const upstreamProxyEnv = profile.network.clientProxy?.upstreamProxyEnv;
  if (upstreamProxyEnv !== undefined) validateEnvironmentName(upstreamProxyEnv);
  if (!Number.isFinite(Date.parse(profile.createdAt)) || !Number.isFinite(Date.parse(profile.updatedAt))) throw new TypeError("invalid profile timestamp");
  return cloneProfile({
    ...profile,
    network: { ...profile.network, clientProxy: { noProxy, allowedPorts, ...(upstreamProxyEnv ? { upstreamProxyEnv } : {}) } }
  });
}

function cloneProfile(profile: RemoteProfile): RemoteProfile {
  return structuredClone(profile);
}

/**
 * Optional fields are absent rather than `undefined` in the stored document, so
 * an edit has three outcomes: keep what is there, clear it, or set a new value.
 */
function resolveOptional<K extends string, V>(key: K, incoming: V | null | undefined, current: V | undefined): Partial<Record<K, V>> {
  if (incoming === undefined) return current === undefined ? {} : { [key]: current } as Partial<Record<K, V>>;
  if (incoming === null) return {};
  return { [key]: incoming } as Partial<Record<K, V>>;
}
