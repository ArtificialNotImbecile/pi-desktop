import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { access, link, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { EgressBroker, type EgressSession } from "./egress.js";
import { ProxyAuditLog } from "./audit.js";
import { PiRemoteError } from "./errors.js";
import { DaemonClient, PiRpcSessionPort, resolveSessionMetadata, type ControlTransport } from "./rpc.js";
import { ProfileStore } from "./profiles.js";
import { SshRunner, redactDiagnostic, remoteRootShellExpression, shellQuote } from "./ssh.js";
import {
  CONTROL_PROTOCOL_VERSION,
  RUNTIME_NODE_VERSION,
  RUNTIME_PI_VERSION,
  RUNTIME_VERSION,
  type DoctorCheck,
  type DoctorReport,
  type OpenSessionOptions,
  type OpenTuiOptions,
  type RemoteProfile,
  type RemoteModelConfig,
  type RemoteRuntimeManager,
  type RemoteSessionPort,
  type RemoteSessionMetadata,
  type RemoteSessionChunk,
  type ReadSessionOptions,
  type RuntimeUseOptions,
  type RuntimeInfo
} from "./types.js";

/** Printed by the probe when the host answers that no runtime is installed. */
const RUNTIME_ABSENT_MARKER = "PI_REMOTE_RUNTIME_ABSENT";

interface ArtifactDescriptor {
  version: 1;
  platform: "linux";
  arch: "x64";
  libcMinimum: "2.27";
  runtimeVersion: string;
  piVersion: string;
  archive: string;
  archiveSha256: string;
}

export class ManagedRemoteRuntime implements RemoteRuntimeManager {
  readonly ssh: SshRunner;

  constructor(options: { ssh?: SshRunner; artifactDirectory?: string } = {}) {
    this.ssh = options.ssh ?? new SshRunner();
    this.artifactDirectory = options.artifactDirectory ?? defaultArtifactDirectory();
  }

  private readonly artifactDirectory: string;

  async doctor(profile: RemoteProfile): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    let probe;
    try {
      probe = await this.ssh.probe(profile);
      checks.push({ id: "ssh", status: "pass", message: "OpenSSH connection and non-interactive shell are usable." });
    } catch (error) {
      const normalized = error instanceof PiRemoteError ? error : new PiRemoteError("ssh-failed", "SSH probe failed.", { phase: "ssh", cause: error });
      checks.push({ id: "ssh", status: "fail", message: normalized.message, details: normalized.safeDetails });
      return { ok: false, profile: profileSummary(profile), checks };
    }
    const platformOk = probe.platform === "Linux" && probe.arch === "x86_64";
    checks.push({
      id: "platform",
      status: platformOk ? "pass" : "fail",
      message: platformOk ? "Remote platform is supported Linux x64." : `Unsupported remote platform ${probe.platform}/${probe.arch}.`,
      details: { platform: probe.platform, arch: probe.arch, libc: probe.libc }
    });
    const libcOk = isSupportedGlibc(probe.libc);
    checks.push({ id: "libc", status: libcOk ? "pass" : "fail", message: libcOk ? `${probe.libc} satisfies the glibc 2.27 baseline.` : `${probe.libc} is below the supported glibc 2.27 baseline.` });
    checks.push({ id: "home", status: probe.homeWritable ? "pass" : "fail", message: probe.homeWritable ? "Remote home is writable." : "Remote home is not writable." });
    checks.push({ id: "tar", status: probe.tar ? "pass" : "fail", message: probe.tar ? "tar is available for offline runtime extraction." : "tar is required for runtime extraction." });
    checks.push({ id: "sha256sum", status: probe.sha256sum ? "pass" : "fail", message: probe.sha256sum ? "sha256sum is available for pre-execution artifact verification." : "sha256sum is required for pre-execution artifact verification." });
    checks.push(await this.backgroundSurvivalCheck(profile));
    if (profile.network.mode === "client-proxy") checks.push(await this.ssh.forwardingCheck(profile, randomInt(49_152, 65_536)));
    try {
      await this.readArtifact();
      checks.push({ id: "artifact", status: "pass", message: "Bundled Linux x64 runtime artifact is present and described." });
    } catch (error) {
      checks.push({ id: "artifact", status: "fail", message: error instanceof Error ? error.message : "Runtime artifact is unavailable." });
    }
    return { ok: checks.every((check) => check.status !== "fail"), profile: profileSummary(profile), checks };
  }

  async ensureRuntime(profile: RemoteProfile): Promise<RuntimeInfo> {
    const artifact = await this.readArtifact();
    const existing = await this.runtimeInfo(profile, artifact).catch(() => null);
    if (existing) {
      await this.activateRuntime(profile, artifact);
      return existing;
    }
    const probe = await this.ssh.probe(profile);
    if (probe.platform !== "Linux" || probe.arch !== "x86_64" || !isSupportedGlibc(probe.libc) || !probe.homeWritable || !probe.tar || !probe.sha256sum) {
      throw new PiRemoteError("remote-platform-unsupported", `Remote host ${probe.platform}/${probe.arch}/${probe.libc} does not satisfy the Linux x64 runtime contract.`, {
        phase: "probe",
        safeDetails: { platform: probe.platform, arch: probe.arch, libc: probe.libc, homeWritable: probe.homeWritable, tar: probe.tar, sha256sum: probe.sha256sum }
      });
    }
    await this.installArtifact(profile, artifact);
    return this.runtimeInfo(profile, artifact);
  }

  private resolveRuntime(profile: RemoteProfile, options: RuntimeUseOptions): Promise<RuntimeInfo> {
    return options.install === false ? this.requireRuntime(profile) : this.ensureRuntime(profile);
  }

  /**
   * Resolves the runtime already on the host and refuses rather than installing
   * one. Reading a host's history must never turn into an ~83 MB upload the
   * caller did not ask for; installing stays an explicit action.
   */
  async requireRuntime(profile: RemoteProfile): Promise<RuntimeInfo> {
    const artifact = await this.readArtifact();
    // Only an answered "not installed" becomes this code. A host that could not
    // be reached keeps its own error, so the caller does not report a missing
    // runtime when the real problem is the connection.
    const existing = await this.probeInstalledRuntime(profile, artifact);
    if (!existing) {
      throw new PiRemoteError("runtime-not-installed", "The managed runtime is not installed on this host yet.", {
        phase: "runtime",
        remediation: "Install the runtime for this profile, then try again."
      });
    }
    await this.activateRuntime(profile, artifact);
    return existing;
  }

  async openTui(profile: RemoteProfile, options: OpenTuiOptions = {}): Promise<number> {
    const info = await this.ensureRuntime(profile);
    const cwd = options.cwd ?? profile.defaultCwd;
    if (!cwd) throw new PiRemoteError("cwd-required", "Remote TUI requires a profile cwd or --cwd.", { phase: "session" });
    const egress = await this.startEgress(profile, info);
    const ticket = randomBytes(24).toString("base64url");
    const piArgs = [
      ...(options.continueSession ? ["--continue"] : []),
      ...(options.resume ? ["--resume"] : []),
      ...(options.sessionId ? ["--session", options.sessionId] : []),
      ...(options.piArgs ?? [])
    ];
    const descriptor = {
      cwd,
      piArgs,
      ...(egress ? { proxy: { url: egress.proxyUrl, noProxy: egress.noProxy } } : {})
    };
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      await this.putDescriptor(profile, info, ticket, descriptor);
      const command = this.hostCommand(profile, info, ["tui", "attach", "--ticket", ticket]);
      child = this.ssh.spawn(profile, command, { tty: true, stdio: "inherit" });
      const [code] = await once(child, "exit") as [number | null];
      return code ?? 255;
    } finally {
      await egress?.close();
    }
  }

  async openSession(profile: RemoteProfile, options: OpenSessionOptions = {}): Promise<RemoteSessionPort> {
    const info = await this.ensureRuntime(profile);
    let cwd = options.cwd ?? profile.defaultCwd;
    const egress = await this.startEgress(profile, info);
    let connection: Awaited<ReturnType<ManagedRemoteRuntime["connectDaemon"]>>;
    try {
      connection = await this.connectDaemon(profile, info);
    } catch (error) {
      await egress?.close();
      throw error;
    }
    const { child, client, remoteInfo } = connection;
    try {
      let resolvedSessionId = options.sessionId;
      if (resolvedSessionId) {
        const sessions = await client.request("sessions.list") as Array<{ id: string; cwd?: string }>;
        const session = resolveSessionForOpen(sessions, resolvedSessionId, cwd);
        resolvedSessionId = session.id;
        cwd = session.cwd || cwd;
      }
      if (!cwd) throw new PiRemoteError("cwd-required", "Headless remote session requires a profile cwd, --cwd, or a stored session cwd.", { phase: "session" });
      await client.request("rpc.start", {
        cwd,
        ...(resolvedSessionId ? { sessionId: resolvedSessionId, piArgs: ["--session", resolvedSessionId] } : {}),
        ...(egress ? { proxy: { url: egress.proxyUrl, noProxy: egress.noProxy } } : {})
      });
      const port = new PiRpcSessionPort(
        client,
        remoteInfo.capabilities,
        egress ? { url: egress.proxyUrl, noProxy: egress.noProxy } : undefined,
        remoteInfo.daemonId
      );
      if (resolvedSessionId) port.sessionId = resolvedSessionId;
      return wrapPortResources(port, egress, child);
    } catch (error) {
      client.close();
      child.kill();
      await egress?.close();
      throw error;
    }
  }

  async listSessions(profile: RemoteProfile, options: RuntimeUseOptions = {}): Promise<RemoteSessionMetadata[]> {
    return (await this.listSessionsWithRuntime(profile, options)).sessions;
  }

  /** Reopens the stable client-proxy lease after Jasmine itself restarts. */
  async reconnectDetachedEgress(profile: RemoteProfile, info?: RuntimeInfo): Promise<EgressSession> {
    const runtimeInfo = info ?? await this.requireRuntime(profile);
    const egress = await this.startEgress(profile, runtimeInfo);
    if (!egress) {
      throw new PiRemoteError("egress-mode-invalid", "Detached egress can only be reconnected for a client-proxy profile.", { phase: "egress" });
    }
    return egress;
  }

  async listSessionsWithRuntime(profile: RemoteProfile, options: RuntimeUseOptions = {}): Promise<{
    sessions: RemoteSessionMetadata[];
    runtimeInfo: RuntimeInfo;
  }> {
    const info = await this.resolveRuntime(profile, options);
    const { child, client, remoteInfo } = await this.connectDaemon(profile, info);
    try {
      return {
        sessions: await client.request("sessions.list") as RemoteSessionMetadata[],
        runtimeInfo: remoteInfo
      };
    } finally {
      client.close();
      child.kill();
    }
  }

  async inspectRuntime(profile: RemoteProfile, options: RuntimeUseOptions = {}): Promise<RuntimeInfo> {
    const info = await this.resolveRuntime(profile, options);
    const { child, client, remoteInfo } = await this.connectDaemon(profile, info);
    client.close();
    child.kill();
    return remoteInfo;
  }

  async readSession(profile: RemoteProfile, sessionId: string, options: ReadSessionOptions = {}): Promise<RemoteSessionChunk> {
    const info = await this.resolveRuntime(profile, options);
    const { child, client } = await this.connectDaemon(profile, info);
    try {
      return await client.request("sessions.read", {
        id: sessionId,
        ...(options.fromOffset === undefined ? {} : { fromOffset: options.fromOffset }),
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
      }) as RemoteSessionChunk;
    } finally {
      client.close();
      child.kill();
    }
  }

  private async connectDaemon(profile: RemoteProfile, info: RuntimeInfo): Promise<{
    child: ChildProcessWithoutNullStreams;
    client: DaemonClient;
    remoteInfo: RuntimeInfo;
  }> {
    await this.ensureDaemon(profile, info);
    const child = this.ssh.spawn(profile, this.hostCommand(profile, info, ["daemon", "proxy"]));
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    const transport: ControlTransport = {
      readable: child.stdout,
      writable: child.stdin,
      close: () => child.kill()
    };
    const client = new DaemonClient(transport);
    const remoteInfo = await client.connect().catch((error) => {
      child.kill();
      throw new PiRemoteError("daemon-proxy-failed", "Failed to establish the remote daemon protocol.", {
        phase: "protocol",
        retryable: true,
        safeDetails: { diagnostic: redactDiagnostic(stderr).slice(0, 400) },
        cause: error
      });
    });
    return { child, client, remoteInfo };
  }

  async stop(profile: RemoteProfile): Promise<void> {
    const remoteRoot = remoteRootShellExpression(profile);
    const command = [
      "set -eu",
      `root=${remoteRoot}`,
      "runtime=$(readlink -f \"$root/current\")",
      "test -x \"$runtime/bin/pi-remote-host\"",
      `exec \"$runtime/bin/pi-remote-host\" daemon stop --profile ${shellQuote(profile.id)} --remote-root \"$root\" --runtime-root \"$runtime\" --artifact-sha ${"0".repeat(64)}`
    ].join("; ");
    const result = await this.ssh.run(profile, command);
    if (result.code !== 0) throw new PiRemoteError("remote-stop-failed", "Failed to stop the managed remote runtime.", {
      phase: "runtime",
      retryable: true,
      safeDetails: { exitCode: result.code, diagnostic: redactDiagnostic(result.stderr).slice(0, 400) }
    });
  }

  async authList(profile: RemoteProfile): Promise<Array<{ provider: string; type: string }>> {
    const info = await this.ensureRuntime(profile);
    const result = await this.ssh.run(profile, this.hostCommand(profile, info, ["auth", "list"]));
    if (result.code !== 0) throw hostCommandError("auth-list-failed", "Failed to list remote credentials.", "auth", result);
    return (parseLifecycle(result.stdout, "PI_REMOTE_AUTH/1").providers as Array<{ provider: string; type: string }> | undefined) ?? [];
  }

  async authImport(profile: RemoteProfile, provider: string, credential: unknown): Promise<void> {
    const info = await this.ensureRuntime(profile);
    const result = await this.ssh.run(profile, this.hostCommand(profile, info, ["auth", "import", "--provider", provider]), JSON.stringify(credential));
    if (result.code !== 0) throw hostCommandError("auth-import-failed", "Failed to import the selected remote credential.", "auth", result);
    parseLifecycle(result.stdout, "PI_REMOTE_AUTH/1");
  }

  async authRemove(profile: RemoteProfile, provider: string): Promise<void> {
    const info = await this.ensureRuntime(profile);
    const result = await this.ssh.run(profile, this.hostCommand(profile, info, ["auth", "remove", "--provider", provider]));
    if (result.code !== 0) throw hostCommandError("auth-remove-failed", "Failed to remove the selected remote credential.", "auth", result);
    parseLifecycle(result.stdout, "PI_REMOTE_AUTH/1");
  }

  async syncModelConfig(profile: RemoteProfile, config: RemoteModelConfig): Promise<Record<string, unknown>> {
    const info = await this.ensureRuntime(profile);
    const result = await this.ssh.run(profile, this.hostCommand(profile, info, ["config", "sync"]), JSON.stringify(config));
    if (result.code !== 0) throw hostCommandError("config-sync-failed", "Failed to synchronize local Pi model configuration.", "config", result);
    return parseLifecycle(result.stdout, "PI_REMOTE_CONFIG/1");
  }

  async putFile(profile: RemoteProfile, localPath: string, remotePath: string, force = false): Promise<Record<string, unknown>> {
    const info = await this.ensureRuntime(profile);
    const encoded = Buffer.from(remotePath, "utf8").toString("base64url");
    const child = this.ssh.spawn(profile, this.hostCommand(profile, info, ["file", "put", "--path", encoded, ...(force ? ["--force"] : [])]));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    let code: number | null;
    try {
      [[code]] = await Promise.all([
        once(child, "exit") as Promise<[number | null]>,
        pipeline(createReadStream(localPath), child.stdin),
        once(child.stdout, "end")
      ]);
    } catch (error) {
      child.kill();
      throw new PiRemoteError("file-put-failed", "Failed while sending the local file.", {
        phase: "file",
        safeDetails: { diagnostic: redactDiagnostic(stderr).slice(0, 400) },
        cause: error
      });
    }
    if (code !== 0) throw hostCommandError("file-put-failed", "Failed to upload the local file.", "file", { code: code ?? 255, stdout, stderr });
    return parseLifecycle(stdout, "PI_REMOTE_FILE/1");
  }

  async getFile(profile: RemoteProfile, remotePath: string, localPath: string, force = false): Promise<void> {
    if (!force && existsSync(localPath)) throw new PiRemoteError("local-file-exists", "Local target already exists; use --force to replace it.", { phase: "file" });
    const info = await this.ensureRuntime(profile);
    const encoded = Buffer.from(remotePath, "utf8").toString("base64url");
    const child = this.ssh.spawn(profile, this.hostCommand(profile, info, ["file", "get", "--path", encoded]));
    await mkdir(path.dirname(path.resolve(localPath)), { recursive: true });
    const temporary = `${path.resolve(localPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    let code: number | null;
    try {
      [[code]] = await Promise.all([
        once(child, "exit") as Promise<[number | null]>,
        pipeline(child.stdout, output)
      ]);
    } catch (error) {
      child.kill();
      await rm(temporary, { force: true }).catch(() => {});
      throw new PiRemoteError("file-get-failed", "Failed while receiving the remote file.", {
        phase: "file",
        safeDetails: { diagnostic: redactDiagnostic(stderr).slice(0, 400) },
        cause: error
      });
    }
    if (code !== 0) {
      await rm(temporary, { force: true }).catch(() => {});
      throw hostCommandError("file-get-failed", "Failed to download the remote file.", "file", { code: code ?? 255, stdout: "", stderr });
    }
    const target = path.resolve(localPath);
    try {
      if (force) await rename(temporary, target);
      else await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PiRemoteError("local-file-exists", "Local target was created during download; use --force to replace it.", { phase: "file" });
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async backgroundSurvivalCheck(profile: RemoteProfile): Promise<DoctorCheck> {
    const ticket = randomBytes(10).toString("hex");
    const marker = `/tmp/pi-remote-survival-${ticket}`;
    const launch = await this.ssh.run(profile, `nohup sh -c ${shellQuote(`sleep 1; printf ok > ${marker}`)} </dev/null >/dev/null 2>&1 &`);
    if (launch.code !== 0) return { id: "background-survival", status: "fail", message: "Remote shell could not launch a detached sentinel." };
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const verify = await this.ssh.run(profile, `if test -f ${shellQuote(marker)}; then rm -f ${shellQuote(marker)}; printf 'PI_REMOTE_SURVIVED/1\\n'; fi`);
    return verify.stdout.trim() === "PI_REMOTE_SURVIVED/1"
      ? { id: "background-survival", status: "pass", message: "Detached user processes survive an SSH transport disconnect." }
      : { id: "background-survival", status: "fail", message: "Host policy terminates detached user processes after SSH disconnect." };
  }

  private async readArtifact(): Promise<ArtifactDescriptor & { archivePath: string }> {
    const descriptorPath = path.join(this.artifactDirectory, "artifact.json");
    let descriptor: ArtifactDescriptor;
    try {
      descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as ArtifactDescriptor;
    } catch (error) {
      throw new PiRemoteError("runtime-artifact-missing", "Bundled Linux x64 runtime artifact is missing.", {
        phase: "install",
        remediation: "Run `npm run runtime:fetch` to download the pinned runtime archive (or `npm run runtime:build:linux-x64` to rebuild it) before packaging.",
        safeDetails: { descriptorPath },
        cause: error
      });
    }
    if (descriptor.version !== 1 || descriptor.runtimeVersion !== RUNTIME_VERSION || descriptor.piVersion !== RUNTIME_PI_VERSION || !/^[0-9a-f]{64}$/u.test(descriptor.archiveSha256)) {
      throw new PiRemoteError("runtime-artifact-invalid", "Bundled runtime descriptor does not match this package version.", { phase: "install" });
    }
    const archivePath = path.join(this.artifactDirectory, descriptor.archive);
    await access(archivePath);
    const actualSha256 = await sha256File(archivePath);
    if (actualSha256 !== descriptor.archiveSha256) {
      throw new PiRemoteError("runtime-artifact-hash-mismatch", "Bundled runtime archive does not match artifact.json.", {
        phase: "install",
        safeDetails: { expected: descriptor.archiveSha256, actual: actualSha256 }
      });
    }
    return { ...descriptor, archivePath };
  }

  private async runtimeInfo(profile: RemoteProfile, artifact: ArtifactDescriptor & { archivePath: string }): Promise<RuntimeInfo> {
    const remoteRoot = remoteRootShellExpression(profile);
    const command = [
      "set -eu",
      `root=${remoteRoot}`,
      `runtime=\"$root/runtimes/${artifact.archiveSha256}\"`,
      "test -x \"$runtime/bin/pi-remote-host\"",
      `exec \"$runtime/bin/pi-remote-host\" runtime info --runtime-root \"$runtime\" --artifact-sha ${artifact.archiveSha256} --remote-root \"$root\" --profile ${shellQuote(profile.id)}`
    ].join("; ");
    const result = await this.ssh.run(profile, command, undefined, 20_000);
    if (result.code !== 0) throw new PiRemoteError("remote-runtime-missing", "Managed remote runtime is not installed.", { phase: "runtime", retryable: true });
    return this.toRuntimeInfo(profile, artifact, parseLifecycle(result.stdout, "PI_REMOTE_RUNTIME/1"));
  }

  /**
   * Asks whether the runtime is installed in a way that separates "the host
   * says no" from "the host did not answer". A non-zero exit here is a
   * connection or protocol failure and keeps its own remediation, because
   * telling someone to install a runtime when the real problem is an
   * unreachable host sends them to the wrong place.
   */
  private async probeInstalledRuntime(
    profile: RemoteProfile,
    artifact: ArtifactDescriptor & { archivePath: string }
  ): Promise<RuntimeInfo | null> {
    const remoteRoot = remoteRootShellExpression(profile);
    const command = [
      "set -eu",
      `root=${remoteRoot}`,
      `runtime=\"$root/runtimes/${artifact.archiveSha256}\"`,
      `if [ ! -x \"$runtime/bin/pi-remote-host\" ]; then printf '%s\\n' '${RUNTIME_ABSENT_MARKER}'; exit 0; fi`,
      `exec \"$runtime/bin/pi-remote-host\" runtime info --runtime-root \"$runtime\" --artifact-sha ${artifact.archiveSha256} --remote-root \"$root\" --profile ${shellQuote(profile.id)}`
    ].join("; ");
    const result = await this.ssh.run(profile, command, undefined, 20_000);
    if (result.code !== 0) {
      throw new PiRemoteError("remote-runtime-probe-failed", "The host did not answer whether the managed runtime is installed.", {
        phase: "runtime",
        retryable: true,
        remediation: "Check that the host is reachable over SSH, then try again.",
        safeDetails: { exitCode: result.code, diagnostic: redactDiagnostic(result.stderr).slice(0, 400) }
      });
    }
    if (result.stdout.includes(RUNTIME_ABSENT_MARKER)) return null;
    return this.toRuntimeInfo(profile, artifact, parseLifecycle(result.stdout, "PI_REMOTE_RUNTIME/1"));
  }

  private toRuntimeInfo(
    profile: RemoteProfile,
    artifact: ArtifactDescriptor & { archivePath: string },
    value: Record<string, unknown>
  ): RuntimeInfo {
    const rootValue = typeof value.remoteRoot === "string" ? value.remoteRoot : profile.remoteRoot ?? DEFAULT_REMOTE_ROOT_DISPLAY;
    const profileRoot = typeof value.profileRoot === "string" ? value.profileRoot : `${rootValue}/profiles/${profile.id}`;
    const sessionRoot = typeof value.sessionRoot === "string" ? value.sessionRoot : `${profileRoot}/sessions`;
    return {
      controlVersion: CONTROL_PROTOCOL_VERSION,
      runtimeVersion: String(value.runtimeVersion),
      piVersion: String(value.piVersion),
      nodeVersion: RUNTIME_NODE_VERSION,
      platform: "linux",
      arch: "x64",
      artifactSha256: artifact.archiveSha256,
      capabilities: ["native-tui", "rpc-jsonl", "client-proxy"],
      remoteRoot: rootValue,
      profileRoot,
      sessionRoot,
      daemonId: null,
      activeRpc: null
    };
  }

  private async installArtifact(profile: RemoteProfile, artifact: ArtifactDescriptor & { archivePath: string }): Promise<void> {
    const remoteRoot = remoteRootShellExpression(profile);
    const sha = artifact.archiveSha256;
    const command = [
      "set -eu",
      `root=${remoteRoot}`,
      `sha=${shellQuote(sha)}`,
      "runtime=\"$root/runtimes/$sha\"",
      "if test -x \"$runtime/bin/pi-remote-host\"; then cat >/dev/null; link=\"$root/current.$$.tmp\"; ln -s \"runtimes/$sha\" \"$link\"; mv -Tf \"$link\" \"$root/current\"; printf 'PI_REMOTE_INSTALL/1\\tREUSED\\n'; exit 0; fi",
      "stage=\"$root/.staging/$sha.$$\"",
      "mkdir -p \"$root/runtimes\" \"$root/.staging\"",
      "rm -rf \"$stage\"",
      "mkdir -m 700 \"$stage\"",
      "trap 'rm -rf \"$stage\"' EXIT HUP INT TERM",
      "tar -xzf - -C \"$stage\"",
      "(cd \"$stage\" && sha256sum -c SHA256SUMS >/dev/null)",
      "chmod 700 \"$stage/bin/pi-remote-host\"",
      "\"$stage/bin/pi-remote-host\" runtime verify --runtime-root \"$stage\" --artifact-sha \"$sha\" >/dev/null",
      "if mv -T \"$stage\" \"$runtime\" 2>/dev/null; then :; else test -x \"$runtime/bin/pi-remote-host\"; rm -rf \"$stage\"; fi",
      "trap - EXIT HUP INT TERM",
      "link=\"$root/current.$$.tmp\"",
      "ln -s \"runtimes/$sha\" \"$link\"",
      "mv -Tf \"$link\" \"$root/current\"",
      "printf 'PI_REMOTE_INSTALL/1\\tINSTALLED\\n'"
    ].join("; ");
    const child = this.ssh.spawn(profile, command);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    let code: number | null;
    try {
      [[code]] = await Promise.all([
        once(child, "exit") as Promise<[number | null]>,
        pipeline(createReadStream(artifact.archivePath), child.stdin),
        once(child.stdout, "end")
      ]);
    } catch (error) {
      child.kill();
      throw new PiRemoteError("remote-install-failed", "Offline runtime upload failed before installation completed.", {
        phase: "install", retryable: true,
        safeDetails: { diagnostic: redactDiagnostic(stderr).slice(0, 500) },
        cause: error
      });
    }
    if (code !== 0 || !stdout.includes("PI_REMOTE_INSTALL/1")) {
      throw new PiRemoteError("remote-install-failed", "Offline remote runtime installation failed.", {
        phase: "install",
        retryable: true,
        safeDetails: { exitCode: code ?? 255, diagnostic: redactDiagnostic(stderr).slice(0, 500) }
      });
    }
  }

  private async activateRuntime(profile: RemoteProfile, artifact: ArtifactDescriptor): Promise<void> {
    const remoteRoot = remoteRootShellExpression(profile);
    const sha = artifact.archiveSha256;
    const command = [
      "set -eu",
      `root=${remoteRoot}`,
      `sha=${shellQuote(sha)}`,
      "runtime=\"$root/runtimes/$sha\"",
      "test -x \"$runtime/bin/pi-remote-host\"",
      "link=\"$root/current.$$.tmp\"",
      "trap 'rm -f \"$link\"' EXIT HUP INT TERM",
      "ln -s \"runtimes/$sha\" \"$link\"",
      "mv -Tf \"$link\" \"$root/current\"",
      "trap - EXIT HUP INT TERM",
      "printf 'PI_REMOTE_ACTIVATE/1\\n'"
    ].join("; ");
    const result = await this.ssh.run(profile, command);
    if (result.code !== 0 || result.stdout.trim() !== "PI_REMOTE_ACTIVATE/1") {
      throw new PiRemoteError("runtime-activation-failed", "Failed to select the installed managed runtime.", {
        phase: "runtime",
        retryable: true,
        safeDetails: { exitCode: result.code, diagnostic: redactDiagnostic(result.stderr).slice(0, 400) }
      });
    }
  }

  private async putDescriptor(profile: RemoteProfile, info: RuntimeInfo, ticket: string, descriptor: unknown): Promise<void> {
    const result = await this.ssh.run(profile, this.hostCommand(profile, info, ["descriptor", "put", "--ticket", ticket]), JSON.stringify(descriptor));
    if (result.code !== 0) throw new PiRemoteError("descriptor-upload-failed", "Failed to transfer the private remote run descriptor.", {
      phase: "protocol",
      safeDetails: { exitCode: result.code, diagnostic: redactDiagnostic(result.stderr).slice(0, 400) }
    });
  }

  private async ensureDaemon(profile: RemoteProfile, info: RuntimeInfo): Promise<void> {
    const result = await this.ssh.run(profile, this.hostCommand(profile, info, ["daemon", "ensure"]));
    if (result.code !== 0) throw new PiRemoteError("daemon-start-failed", "Failed to start the remote profile daemon.", {
      phase: "runtime", safeDetails: { exitCode: result.code, diagnostic: redactDiagnostic(result.stderr).slice(0, 400) }
    });
  }

  hostCommand(profile: RemoteProfile, info: RuntimeInfo, args: string[]): string {
    const remoteRoot = remoteRootShellExpression(profile);
    const argText = args.map(shellQuote).join(" ");
    return [
      "set -eu",
      `root=${remoteRoot}`,
      `runtime=\"$root/runtimes/${info.artifactSha256}\"`,
      `exec \"$runtime/bin/pi-remote-host\" ${argText} --profile ${shellQuote(profile.id)} --remote-root \"$root\" --runtime-root \"$runtime\" --artifact-sha ${shellQuote(info.artifactSha256)}`
    ].join("; ");
  }

  private async startEgress(profile: RemoteProfile, info: RuntimeInfo): Promise<EgressSession | undefined> {
    if (profile.network.mode !== "client-proxy") return undefined;
    const leaseResult = await this.ssh.run(profile, this.hostCommand(profile, info, ["egress", "lease"]));
    if (leaseResult.code !== 0) throw new PiRemoteError("egress-lease-failed", "Failed to acquire the profile egress lease.", {
      phase: "egress",
      retryable: true,
      safeDetails: { exitCode: leaseResult.code }
    });
    const leaseValue = parseSecretLifecycle(leaseResult.stdout, "PI_REMOTE_EGRESS_CONFIG/1");
    const token = leaseValue.token;
    const remotePort = leaseValue.remotePort;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/u.test(token)
      || !Number.isInteger(remotePort) || Number(remotePort) < 49_152 || Number(remotePort) > 65_535) {
      throw new PiRemoteError("egress-lease-invalid", "Remote profile returned an invalid egress lease.", { phase: "egress" });
    }
    const audit = new ProxyAuditLog(profile);
    const session = await new EgressBroker(profile, this.ssh, (event) => audit.write(event), { token, remotePort: Number(remotePort) }).start();
    return {
      ...session,
      close: async () => {
        await session.close();
        await audit.flush();
      }
    };
  }
}

export function resolveSessionForOpen(sessions: Array<{ id: string; cwd?: string }>, requestedId: string, explicitCwd?: string): { id: string; cwd?: string } {
  try {
    return resolveSessionMetadata(sessions, requestedId);
  } catch (error) {
    if (error instanceof PiRemoteError && error.code === "session-not-found" && explicitCwd && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(requestedId)) {
      return { id: requestedId, cwd: explicitCwd };
    }
    throw error;
  }
}

function defaultArtifactDirectory(): string {
  return fileURLToPath(new URL("../runtime/linux-x64-glibc", import.meta.url));
}

function parseLifecycle(stdout: string, marker: string): Record<string, unknown> {
  const normalized = stdout.replace(/\r\n/gu, "\n").trimEnd();
  const lines = normalized.split("\n");
  if (lines.length !== 1 || !lines[0]!.startsWith(`${marker}\t`)) {
    throw new PiRemoteError("remote-shell-output-contaminated", "Remote lifecycle command produced unexpected stdout.", {
      phase: "protocol",
      safeDetails: { sample: redactDiagnostic(normalized).slice(0, 240) }
    });
  }
  return JSON.parse(Buffer.from(lines[0]!.slice(marker.length + 1), "base64url").toString("utf8")) as Record<string, unknown>;
}

function parseSecretLifecycle(stdout: string, marker: string): Record<string, unknown> {
  const normalized = stdout.replace(/\r\n/gu, "\n").trimEnd();
  const lines = normalized.split("\n");
  if (lines.length !== 1 || !lines[0]!.startsWith(`${marker}\t`)) {
    throw new PiRemoteError("remote-shell-output-contaminated", "Remote secret lifecycle command produced unexpected stdout.", {
      phase: "protocol"
    });
  }
  try {
    return JSON.parse(Buffer.from(lines[0]!.slice(marker.length + 1), "base64url").toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new PiRemoteError("secret-lifecycle-invalid", "Remote secret lifecycle payload is invalid.", { phase: "protocol", cause: error });
  }
}

function isSupportedGlibc(value: string): boolean {
  const match = /glibc\s+(\d+)\.(\d+)/iu.exec(value);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || major === 2 && minor >= 27;
}

function profileSummary(profile: RemoteProfile): Pick<RemoteProfile, "id" | "name" | "sshHost"> {
  return { id: profile.id, name: profile.name, sshHost: profile.sshHost };
}

function wrapPortResources(port: PiRpcSessionPort, egress: EgressSession | undefined, child: ChildProcessWithoutNullStreams): RemoteSessionPort {
  const originalDetach = port.detach.bind(port);
  const originalClose = port.close.bind(port);
  let released = false;
  const releaseDetachedResources = async () => {
    if (released) return;
    released = true;
    child.kill();
    await egress?.close();
  };
  port.detach = async () => {
    try { await originalDetach(); }
    finally {
      // The daemon connection is disposable, but client-proxy egress is part
      // of the remote process' environment and survives until turn settlement.
      child.kill();
    }
  };
  port.releaseDetachedResources = releaseDetachedResources;
  port.close = async (options) => {
    try { await originalClose(options); }
    finally { await releaseDetachedResources(); }
  };
  return port;
}



const DEFAULT_REMOTE_ROOT_DISPLAY = "~/.local/share/pi-remote";

function hostCommandError(code: string, message: string, phase: "auth" | "config" | "file", result: { code: number; stdout: string; stderr: string }): PiRemoteError {
  return new PiRemoteError(code, message, {
    phase,
    safeDetails: { exitCode: result.code, diagnostic: redactDiagnostic(result.stderr).slice(0, 400) }
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
