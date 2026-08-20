#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  RemoteHostDaemon,
  acquireSessionMode,
  cleanupRunDescriptors,
  consumeRunDescriptor,
  daemonStatus,
  ensureHostPaths,
  hasLiveSessionMode,
  runtimeEnvironment,
  releaseSessionMode,
  refreshSessionModeOwner,
  sessionModeAcquireLockPath,
  storeRunDescriptor,
  type HostPaths
} from "./daemon.js";
import { PiRemoteError, asPiRemoteError } from "./errors.js";
import { withOwnedFileLock } from "./file-lock.js";
import { RUNTIME_PI_VERSION, RUNTIME_VERSION } from "./types.js";

interface HostContext {
  profileId: string;
  remoteRoot: string;
  runtimeRoot: string;
  artifactSha256: string;
  paths: HostPaths;
}

const MAX_CONFIG_SYNC_PAYLOAD_BYTES = 3 * 1024 * 1024;

const args = process.argv.slice(2);

if (isMainModule()) {
  void main(args).then((code) => { process.exitCode = code; }).catch((error) => {
    const normalized = asPiRemoteError(error, { code: "host-failed", message: "pi-remote host command failed.", phase: "runtime" });
    process.stderr.write(`${JSON.stringify(normalized.serialize())}\n`);
    process.exitCode = 1;
  });
}

export async function main(argv: string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === "runtime" && command === "verify") return verifyRuntimeCommand(rest);
  if (group === "runtime" && command === "info") return runtimeInfoCommand(rest);
  if (!group || !command) return usage();
  const context = await hostContext(rest);
  await cleanupRunDescriptors(context.paths);
  if (group === "daemon") {
    if (command === "serve") return daemonServe(context);
    if (command === "ensure") return daemonEnsure(context, true);
    if (command === "status") return daemonStatusCommand(context);
    if (command === "proxy") return daemonProxy(context);
    if (command === "stop") return stopCommand(context);
  }
  if (group === "descriptor" && command === "put") return descriptorPut(context, requiredArg(rest, "--ticket"));
  if (group === "tui" && command === "attach") return tuiAttach(context, requiredArg(rest, "--ticket"));
  if (group === "tui" && command === "child") return tuiChild(context);
  if (group === "auth" && command === "list") return authList(context);
  if (group === "auth" && command === "import") return authImport(context, requiredArg(rest, "--provider"));
  if (group === "auth" && command === "remove") return authRemove(context, requiredArg(rest, "--provider"));
  if (group === "config" && command === "sync") return configSync(context);
  if (group === "egress" && command === "lease") return egressLease(context);
  if (group === "file" && command === "put") return filePut(context, decodePathArg(requiredArg(rest, "--path")), rest.includes("--force"));
  if (group === "file" && command === "get") return fileGet(context, decodePathArg(requiredArg(rest, "--path")));
  return usage();
}

async function hostContext(argv: string[]): Promise<HostContext> {
  const profileId = requiredArg(argv, "--profile");
  const remoteRoot = requiredArg(argv, "--remote-root");
  const runtimeRoot = requiredArg(argv, "--runtime-root");
  const artifactSha256 = requiredArg(argv, "--artifact-sha");
  if (!/^[0-9a-f]{64}$/iu.test(artifactSha256)) throw new PiRemoteError("artifact-sha-invalid", "Runtime artifact SHA-256 is invalid.", { phase: "runtime" });
  return { profileId, remoteRoot, runtimeRoot, artifactSha256, paths: await ensureHostPaths(remoteRoot, runtimeRoot, profileId) };
}

async function daemonServe(context: HostContext): Promise<number> {
  const daemon = new RemoteHostDaemon({
    profileId: context.profileId,
    paths: context.paths,
    artifactSha256: context.artifactSha256
  });
  const shutdown = () => void daemon.close({ abort: true });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await daemon.start();
  await daemon.wait();
  return 0;
}

async function daemonEnsure(context: HostContext, print: boolean): Promise<number> {
  return withOwnedFileLock(path.join(context.paths.runDir, "daemon-start.lock"), async () => {
    let current = await daemonStatus(context.paths);
    if (current.running) {
      if (!daemonMatchesRuntime(current, context)) await replaceIdleStaleDaemon(context);
      current = await daemonStatus(context.paths);
      if (current.running && !daemonMatchesRuntime(current, context)) throw staleDaemonError(current, context);
    }
    if (current.running) {
      if (print) printLifecycle("PI_REMOTE_DAEMON/1", { running: true, pid: current.pid, reused: true });
      return 0;
    }
    await mkdir(context.paths.logDir, { recursive: true, mode: 0o700 });
    const logPath = path.join(context.paths.logDir, "daemon-launch.log");
    const logHandle = await import("node:fs/promises").then(({ open }) => open(logPath, "a", 0o600));
    const child = spawn(process.execPath, selfInvocationArgs([
      "daemon", "serve",
      "--profile", context.profileId,
      "--remote-root", context.remoteRoot,
      "--runtime-root", context.runtimeRoot,
      "--artifact-sha", context.artifactSha256
    ]), {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: process.env
    });
    child.unref();
    await logHandle.close();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const status = await daemonStatus(context.paths);
      if (status.running && daemonMatchesRuntime(status, context) && existsSync(context.paths.socketPath)) {
        if (print) printLifecycle("PI_REMOTE_DAEMON/1", { running: true, pid: status.pid, reused: false });
        return 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new PiRemoteError("daemon-start-failed", "Remote daemon did not become ready within five seconds.", {
      phase: "runtime",
      remediation: `Inspect ${logPath}.`
    });
  });
}

export function daemonMatchesRuntime(
  status: { runtimeVersion?: string; artifactSha256?: string },
  expected: { artifactSha256: string }
): boolean {
  return status.runtimeVersion === RUNTIME_VERSION && status.artifactSha256 === expected.artifactSha256;
}

async function replaceIdleStaleDaemon(context: HostContext): Promise<void> {
  await withOwnedFileLock(sessionModeAcquireLockPath(context.paths), async () => {
    const current = await daemonStatus(context.paths);
    if (!current.running || daemonMatchesRuntime(current, context)) return;
    // Holding the mode acquire lock closes the check-to-kill race: an old
    // daemon cannot start an RPC child, and TUI startup cannot claim the mode,
    // after we have established that no managed work is active.
    if (await hasLiveSessionMode(context.paths)) throw staleDaemonError(current, context);
    await terminateDaemonProcess(context.paths, current.pid!, {
      code: "daemon-upgrade-stop-timeout",
      message: "Idle stale daemon did not finish stopping during the runtime upgrade."
    });
  }, {
    attempts: 100,
    pollMs: 25,
    timeoutCode: "session-mode-lock-timeout",
    timeoutMessage: "Timed out waiting to inspect the active runtime mode during upgrade.",
    phase: "session"
  });
}

function staleDaemonError(
  current: { runtimeVersion?: string; artifactSha256?: string },
  context: HostContext
): PiRemoteError {
  return new PiRemoteError("daemon-runtime-stale", "The active profile daemon belongs to a different managed runtime.", {
    phase: "runtime",
    remediation: "Wait for active work to finish, or run `pi-remote stop <profile>` before connecting with the upgraded runtime.",
    safeDetails: {
      activeRuntimeVersion: current.runtimeVersion ?? null,
      expectedRuntimeVersion: RUNTIME_VERSION,
      activeArtifactSha256: current.artifactSha256 ?? null,
      expectedArtifactSha256: context.artifactSha256
    }
  });
}

async function daemonStatusCommand(context: HostContext): Promise<number> {
  const status = await daemonStatus(context.paths);
  printLifecycle("PI_REMOTE_DAEMON/1", status);
  return status.running ? 0 : 3;
}

async function daemonProxy(context: HostContext): Promise<number> {
  await daemonEnsure(context, false);
  const socket = net.createConnection(context.paths.socketPath);
  socket.on("error", (error) => {
    process.stderr.write(`${JSON.stringify(new PiRemoteError("daemon-proxy-failed", "Failed to connect to remote daemon.", { phase: "protocol", cause: error }).serialize())}\n`);
    process.exitCode = 1;
  });
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  await new Promise<void>((resolve) => socket.once("close", resolve));
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

async function descriptorPut(context: HostContext, ticket: string): Promise<number> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 1024 * 1024) throw new PiRemoteError("descriptor-too-large", "Run descriptor exceeds 1 MiB.", { phase: "protocol" });
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  await storeRunDescriptor(context.paths, ticket, value);
  printLifecycle("PI_REMOTE_DESCRIPTOR/1", { stored: true, ticket });
  return 0;
}

async function tuiAttach(context: HostContext, ticket: string): Promise<number> {
  const descriptor = await consumeRunDescriptor(context.paths, ticket);
  const cwd = requiredAbsolutePath(descriptor.cwd, "cwd");
  const piArgs = Array.isArray(descriptor.piArgs) ? descriptor.piArgs.map(String) : [];
  const sessionDescriptorPath = path.join(context.paths.profileRoot, "tui-session.json");
  const tmux = existsSync(context.paths.tmuxExecutable) ? context.paths.tmuxExecutable : findExecutable("tmux");
  if (!tmux) throw new PiRemoteError("tmux-unavailable", "The managed runtime does not contain tmux and the remote host has no fallback tmux.", { phase: "runtime" });
  const requested = { cwd, piArgs, proxy: descriptor.proxy ?? null, runId: randomBytes(16).toString("hex") };
  const self = process.execPath;
  const childArgs = selfInvocationArgs([
    "tui", "child",
    "--profile", context.profileId,
    "--remote-root", context.remoteRoot,
    "--runtime-root", context.runtimeRoot,
    "--artifact-sha", context.artifactSha256
  ]);
  const tmuxConfig = path.join(context.runtimeRoot, "tmux.conf");
  const tmuxPrefix = ["-L", `pi-remote-${context.profileId.slice(0, 12)}`, "-f", tmuxConfig];
  const tmuxOptions = {
    env: { ...process.env, TMUX_TMPDIR: context.paths.runDir }
  };
  await withOwnedFileLock(`${sessionDescriptorPath}.lock`, async () => {
    const status = spawnSync(tmux, [...tmuxPrefix, "has-session", "-t", "main"], { ...tmuxOptions, stdio: "ignore" });
    if (status.status === 0) {
      const active = await readJsonObject(sessionDescriptorPath);
      if (!tuiRequestMatches(active, requested)) {
        throw new PiRemoteError("tui-session-conflict", "A detached TUI is already active with different connection options.", {
          phase: "session",
          remediation: "Reconnect without changing cwd/session options, or run `pi-remote stop <profile>` first.",
          safeDetails: { activeCwd: typeof active.cwd === "string" ? active.cwd : null, requestedCwd: cwd }
        });
      }
      return;
    }
    await acquireSessionMode(context.paths, "tui", requested.runId);
    try {
      await writeJsonAtomic(sessionDescriptorPath, requested);
      const created = spawnSync(tmux, [
        ...tmuxPrefix,
        "new-session", "-d", "-s", "main", "-c", cwd,
        self, ...childArgs
      ], { ...tmuxOptions, stdio: "ignore" });
      if (!created.error && created.status === 0) return;
      throw new PiRemoteError("tui-start-failed", "Failed to start the managed remote TUI.", {
        phase: "session", safeDetails: { exitCode: created.status ?? null }, cause: created.error
      });
    } catch (error) {
      await releaseSessionMode(context.paths, requested.runId);
      await rm(sessionDescriptorPath, { force: true }).catch(() => {});
      throw error;
    }
  });
  const result = spawnSync(tmux, [...tmuxPrefix, "attach-session", "-t", "main"], {
    stdio: "inherit",
    ...tmuxOptions
  });
  if (result.error) throw result.error;
  return result.status ?? 0;
}

async function tuiChild(context: HostContext): Promise<number> {
  const descriptorPath = path.join(context.paths.profileRoot, "tui-session.json");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<string, unknown>;
  if (typeof descriptor.runId === "string") await refreshSessionModeOwner(context.paths, descriptor.runId);
  const cwd = requiredAbsolutePath(descriptor.cwd, "cwd");
  const piArgs = Array.isArray(descriptor.piArgs) ? descriptor.piArgs.map(String) : [];
  const env = runtimeEnvironment(context.paths, asOptionalObject(descriptor.proxy));
  try {
    const result = spawnSync(context.paths.piExecutable, ["--tui-mode", "fullscreen", ...piArgs], {
      cwd,
      env,
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    const current = await readJsonObject(descriptorPath);
    if (typeof descriptor.runId === "string" && current.runId === descriptor.runId) await rm(descriptorPath, { force: true }).catch(() => {});
    if (typeof descriptor.runId === "string") await releaseSessionMode(context.paths, descriptor.runId);
  }
}

export function tuiRequestMatches(active: Record<string, unknown>, requested: { cwd: string; piArgs: string[]; proxy: unknown }): boolean {
  if (active.cwd !== requested.cwd) return false;
  const activeArgs = Array.isArray(active.piArgs) ? active.piArgs.map(String) : [];
  if (requested.piArgs.length > 0 && JSON.stringify(activeArgs) !== JSON.stringify(requested.piArgs)) return false;
  return JSON.stringify(active.proxy ?? null) === JSON.stringify(requested.proxy ?? null);
}

async function stopCommand(context: HostContext): Promise<number> {
  const sessionDescriptorPath = path.join(context.paths.profileRoot, "tui-session.json");
  await withOwnedFileLock(`${sessionDescriptorPath}.lock`, async () => {
    const tmux = existsSync(context.paths.tmuxExecutable) ? context.paths.tmuxExecutable : findExecutable("tmux");
    if (tmux) {
      spawnSync(tmux, ["-L", `pi-remote-${context.profileId.slice(0, 12)}`, "kill-server"], {
        stdio: "ignore",
        env: { ...process.env, TMUX_TMPDIR: context.paths.runDir }
      });
    }
    await withOwnedFileLock(path.join(context.paths.runDir, "daemon-start.lock"), async () => {
      const status = await daemonStatus(context.paths);
      if (status.running) await terminateDaemonProcess(context.paths, status.pid!, {
        code: "daemon-stop-timeout",
        message: "Remote daemon did not finish stopping within five seconds."
      });
      await rm(sessionDescriptorPath, { force: true }).catch(() => {});
      await rm(path.join(context.paths.profileRoot, "session-mode.json"), { force: true }).catch(() => {});
      await rm(path.join(context.paths.profileRoot, "egress.json"), { force: true }).catch(() => {});
    });
  });
  printLifecycle("PI_REMOTE_STOP/1", { stopped: true });
  return 0;
}

async function terminateDaemonProcess(
  paths: HostPaths,
  pid: number,
  timeout: { code: string; message: string }
): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await daemonStatus(paths);
    if (!current.running && !existsSync(paths.socketPath) && !existsSync(paths.statusPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const remaining = await daemonStatus(paths);
  if (remaining.running || existsSync(paths.socketPath) || existsSync(paths.statusPath)) {
    throw new PiRemoteError(timeout.code, timeout.message, { phase: "runtime", retryable: true });
  }
}

async function egressLease(context: HostContext): Promise<number> {
  const target = path.join(context.paths.profileRoot, "egress.json");
  const lease = await withOwnedFileLock(`${target}.lock`, async () => {
    let current: { version: 1; token: string; remotePort: number } | undefined;
    try {
      const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<{ version: 1; token: string; remotePort: number }>;
      if (parsed.version === 1 && typeof parsed.token === "string" && /^[A-Za-z0-9_-]{43,128}$/u.test(parsed.token)
        && Number.isInteger(parsed.remotePort) && parsed.remotePort! >= 49_152 && parsed.remotePort! <= 65_535) {
        current = parsed as { version: 1; token: string; remotePort: number };
      }
    } catch {
      // Missing or invalid leases are replaced atomically while holding the lock.
    }
    if (!current) {
      current = { version: 1, token: randomBytes(32).toString("base64url"), remotePort: randomInt(49_152, 65_536) };
      await writeJsonAtomic(target, current);
    }
    return current;
  });
  printLifecycle("PI_REMOTE_EGRESS_CONFIG/1", lease);
  return 0;
}

async function authList(context: HostContext): Promise<number> {
  const authPath = path.join(context.paths.agentDir, "auth.json");
  const auth = await readJsonObject(authPath);
  const providers = Object.entries(auth).map(([provider, credential]) => ({
    provider,
    type: credential && typeof credential === "object" && !Array.isArray(credential) && "type" in credential
      ? String((credential as Record<string, unknown>).type)
      : "stored"
  }));
  printLifecycle("PI_REMOTE_AUTH/1", { providers });
  return 0;
}

async function authImport(context: HostContext, provider: string): Promise<number> {
  validateProviderId(provider);
  const raw = await readBoundedStdin(1024 * 1024);
  const credential = JSON.parse(raw.toString("utf8"));
  if (credential === undefined || typeof credential === "function") throw new PiRemoteError("credential-invalid", "Credential payload is invalid.", { phase: "auth" });
  const authPath = path.join(context.paths.agentDir, "auth.json");
  await withOwnedFileLock(`${authPath}.pi-remote.lock`, async () => {
    const auth = await readJsonObject(authPath);
    auth[provider] = credential;
    await writeJsonAtomic(authPath, auth);
  });
  printLifecycle("PI_REMOTE_AUTH/1", { imported: provider });
  return 0;
}

async function authRemove(context: HostContext, provider: string): Promise<number> {
  validateProviderId(provider);
  const authPath = path.join(context.paths.agentDir, "auth.json");
  let existed = false;
  await withOwnedFileLock(`${authPath}.pi-remote.lock`, async () => {
    const auth = await readJsonObject(authPath);
    existed = Object.hasOwn(auth, provider);
    delete auth[provider];
    await writeJsonAtomic(authPath, auth);
  });
  printLifecycle("PI_REMOTE_AUTH/1", { removed: provider, existed });
  return 0;
}

async function configSync(context: HostContext): Promise<number> {
  const payload = JSON.parse((await readBoundedStdin(MAX_CONFIG_SYNC_PAYLOAD_BYTES)).toString("utf8")) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PiRemoteError("config-payload-invalid", "Model configuration payload must be an object.", { phase: "config" });
  }
  const input = payload as Record<string, unknown>;
  const models = input.models;
  const settings = input.settings;
  if (!models || typeof models !== "object" || Array.isArray(models) || !settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new PiRemoteError("config-payload-invalid", "Model configuration requires object-valued models and settings.", { phase: "config" });
  }
  const allowedSettings = new Set(["defaultProvider", "defaultModel", "defaultThinkingLevel"]);
  const settingsInput = settings as Record<string, unknown>;
  for (const [key, value] of Object.entries(settingsInput)) {
    if (!allowedSettings.has(key) || typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new PiRemoteError("config-setting-invalid", `Model setting ${JSON.stringify(key)} is not supported.`, { phase: "config" });
    }
  }
  await withOwnedFileLock(path.join(context.paths.agentDir, ".pi-remote-config.lock"), async () => {
    await writeJsonAtomic(path.join(context.paths.agentDir, "models.json"), models);
    const current = await readJsonObject(path.join(context.paths.agentDir, "settings.json"));
    for (const key of allowedSettings) delete current[key];
    for (const [key, value] of Object.entries(settingsInput)) current[key] = value;
    await writeJsonAtomic(path.join(context.paths.agentDir, "settings.json"), current);
  }, { timeoutCode: "config-lock-timeout", timeoutMessage: "Timed out waiting for the isolated model configuration lock.", phase: "config" });
  const providers = (models as Record<string, unknown>).providers;
  printLifecycle("PI_REMOTE_CONFIG/1", {
    synced: ["models.json", "settings.json"],
    providerCount: providers && typeof providers === "object" && !Array.isArray(providers) ? Object.keys(providers).length : 0,
    settings: Object.keys(settingsInput).sort()
  });
  return 0;
}

async function filePut(context: HostContext, target: string, force: boolean): Promise<number> {
  requiredAbsolutePath(target, "path");
  await mkdir(path.dirname(target), { recursive: true });
  if (!force && existsSync(target)) throw new PiRemoteError("remote-file-exists", "Remote target already exists; use --force to replace it.", { phase: "file" });
  const temporary = `${target}.pi-remote-${process.pid}.tmp`;
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  let outputError: Error | undefined;
  output.on("error", (error) => { outputError = error; });
  let size = 0;
  const hash = createHash("sha256");
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      if (outputError) throw outputError;
      size += buffer.length;
      if (size > 64 * 1024 * 1024) throw new PiRemoteError("remote-file-too-large", "Remote file transfer exceeds 64 MiB.", { phase: "file" });
      hash.update(buffer);
      if (!output.write(buffer)) await new Promise<void>((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const cleanup = () => { output.off("drain", onDrain); output.off("error", onError); };
        output.once("drain", onDrain); output.once("error", onError);
      });
      if (outputError) throw outputError;
    }
    if (outputError) throw outputError;
    await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => error ? reject(error) : resolve()));
    if (force) await rename(temporary, target);
    else { await link(temporary, target); await rm(temporary, { force: true }); }
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PiRemoteError("remote-file-exists", "Remote target was created during upload; use --force to replace it.", { phase: "file" });
    throw error;
  }
  printLifecycle("PI_REMOTE_FILE/1", { path: target, size, sha256: hash.digest("hex") });
  return 0;
}

async function fileGet(_context: HostContext, target: string): Promise<number> {
  requiredAbsolutePath(target, "path");
  const info = await stat(target);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new PiRemoteError("remote-file-invalid", "Remote source must be a regular file no larger than 64 MiB.", { phase: "file" });
  await pipeline(createReadStream(target), process.stdout, { end: false });
  return 0;
}

async function runtimeInfoCommand(argv: string[]): Promise<number> {
  const runtimeRoot = requiredArg(argv, "--runtime-root");
  const artifactSha256 = requiredArg(argv, "--artifact-sha");
  const remoteRoot = optionArg(argv, "--remote-root") || path.dirname(path.dirname(runtimeRoot));
  const profileId = optionArg(argv, "--profile");
  const manifest = await readRuntimeManifest(runtimeRoot);
  printLifecycle("PI_REMOTE_RUNTIME/1", {
    runtimeVersion: RUNTIME_VERSION,
    piVersion: RUNTIME_PI_VERSION,
    artifactSha256,
    manifestVersion: manifest.version,
    runtimeRoot,
    remoteRoot,
    ...(profileId ? {
      profileRoot: path.join(remoteRoot, "profiles", profileId),
      sessionRoot: path.join(remoteRoot, "profiles", profileId, "sessions")
    } : {})
  });
  return 0;
}

async function verifyRuntimeCommand(argv: string[]): Promise<number> {
  const runtimeRoot = requiredArg(argv, "--runtime-root");
  const artifactSha256 = requiredArg(argv, "--artifact-sha");
  const manifest = await readRuntimeManifest(runtimeRoot);
  if (manifest.version !== 1 || manifest.runtimeVersion !== RUNTIME_VERSION || manifest.piVersion !== RUNTIME_PI_VERSION || !Array.isArray(manifest.files)) {
    throw new PiRemoteError("runtime-manifest-invalid", "Runtime manifest does not match the requested artifact.", { phase: "install" });
  }
  for (const file of manifest.files as Array<{ path: string; sha256: string; size: number }>) {
    if (!file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]/u).includes("..")) {
      throw new PiRemoteError("runtime-manifest-path-invalid", "Runtime manifest contains an unsafe path.", { phase: "install" });
    }
    const target = path.join(runtimeRoot, file.path);
    const info = await stat(target);
    if (!info.isFile() || info.size !== file.size) throw new PiRemoteError("runtime-file-size-mismatch", `Runtime file ${file.path} has the wrong size.`, { phase: "install" });
    const sha = await sha256File(target);
    if (sha !== file.sha256) throw new PiRemoteError("runtime-file-hash-mismatch", `Runtime file ${file.path} failed SHA-256 verification.`, { phase: "install" });
  }
  await chmod(path.join(runtimeRoot, "bin", "pi-remote-host"), 0o700);
  await chmod(path.join(runtimeRoot, "pi", "pi"), 0o700);
  if (existsSync(path.join(runtimeRoot, "bin", "tmux"))) await chmod(path.join(runtimeRoot, "bin", "tmux"), 0o700);
  if (existsSync(path.join(runtimeRoot, "bin", "tmux.real"))) await chmod(path.join(runtimeRoot, "bin", "tmux.real"), 0o700);
  if (existsSync(path.join(runtimeRoot, "bin", "fd"))) await chmod(path.join(runtimeRoot, "bin", "fd"), 0o700);
  if (existsSync(path.join(runtimeRoot, "bin", "rg"))) await chmod(path.join(runtimeRoot, "bin", "rg"), 0o700);
  if (existsSync(path.join(runtimeRoot, "bin", "pi-remote-net"))) await chmod(path.join(runtimeRoot, "bin", "pi-remote-net"), 0o700);
  printLifecycle("PI_REMOTE_VERIFY/1", { verified: true, files: manifest.files.length });
  return 0;
}

async function readRuntimeManifest(runtimeRoot: string): Promise<Record<string, any>> {
  const raw = await readFile(path.join(runtimeRoot, "manifest.json"), "utf8");
  return JSON.parse(raw) as Record<string, any>;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function printLifecycle(marker: string, value: unknown): void {
  process.stdout.write(`${marker}\t${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}\n`);
}

function requiredArg(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || /[\0\r\n]/u.test(value)) throw new PiRemoteError("host-argument-missing", `Missing or invalid ${name}.`, { phase: "protocol" });
  return value;
}

function optionArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !/[\0\r\n]/u.test(value) ? value : undefined;
}

function requiredAbsolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new PiRemoteError(`${name}-invalid`, `${name} must be an absolute POSIX path.`, { phase: "session" });
  }
  return value;
}

function asOptionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function findExecutable(name: string): string | undefined {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readBoundedStdin(limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new PiRemoteError("stdin-too-large", "Input exceeds the host command limit.", { phase: "protocol" });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

function validateProviderId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new PiRemoteError("provider-id-invalid", "Provider id is invalid.", { phase: "auth" });
}

function decodePathArg(value: string): string {
  try { return Buffer.from(value, "base64url").toString("utf8"); }
  catch (error) { throw new PiRemoteError("path-encoding-invalid", "Encoded path is invalid.", { phase: "file", cause: error }); }
}

function selfInvocationArgs(nextArgs: string[]): string[] {
  const executable = path.basename(process.execPath).toLocaleLowerCase();
  const runningUnderNode = executable === "node" || executable === "node.exe" || executable === "bun" || executable === "bun.exe";
  return runningUnderNode ? [fileURLToPath(import.meta.url), ...nextArgs] : nextArgs;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return true;
  try { return path.resolve(entry) === fileURLToPath(import.meta.url) || path.resolve(entry) === process.execPath; } catch { return true; }
}

function usage(): number {
  process.stderr.write("Usage: pi-remote-host <runtime|daemon|descriptor|tui> <command> ...\n");
  return 2;
}
