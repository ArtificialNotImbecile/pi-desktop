import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { PiRemoteError } from "./errors.js";
import type { DoctorCheck, RemoteProfile } from "./types.js";

const MAX_CAPTURE_BYTES = 1024 * 1024;

export interface SshCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RemoteProbe {
  platform: string;
  arch: string;
  libc: string;
  homeWritable: boolean;
  tar: boolean;
  sha256sum: boolean;
}

export interface SpawnSshOptions {
  tty?: boolean;
  remoteForward?: { remotePort: number; localHost: string; localPort: number };
  stdio?: SpawnOptions["stdio"];
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export class SshRunner {
  readonly executable: string;
  readonly port?: number;

  constructor(options: { executable?: string; port?: number } = {}) {
    this.executable = options.executable || process.env.PI_REMOTE_SSH_COMMAND || "ssh";
    this.port = options.port;
  }

  baseArgs(profile: RemoteProfile): string[] {
    const port = profile.sshPort ?? this.port;
    return [
      ...(port ? ["-p", String(port)] : []),
      "-o", "BatchMode=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "ClearAllForwardings=yes",
      profile.sshHost
    ];
  }

  spawn(profile: RemoteProfile, remoteCommand: string, options: SpawnSshOptions = {}): ChildProcessWithoutNullStreams {
    return spawn(this.executable, this.buildArgs(profile, remoteCommand, options), {
      windowsHide: true,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "pipe"
    }) as ChildProcessWithoutNullStreams;
  }

  buildArgs(profile: RemoteProfile, remoteCommand: string, options: SpawnSshOptions = {}): string[] {
    const args = this.baseArgs(profile);
    if (options.remoteForward) {
      const clearIndex = args.indexOf("ClearAllForwardings=yes");
      if (clearIndex >= 1 && args[clearIndex - 1] === "-o") args.splice(clearIndex - 1, 2);
    }
    args.splice(args.length - 1, 0, options.tty ? "-tt" : "-T");
    if (options.remoteForward) {
      const forward = options.remoteForward;
      args.splice(args.length - 1, 0,
        "-o", "ExitOnForwardFailure=yes",
        "-R", `127.0.0.1:${forward.remotePort}:${forward.localHost}:${forward.localPort}`);
    }
    if (options.extraArgs?.length) args.splice(args.length - 1, 0, ...options.extraArgs);
    args.push(remoteCommand);
    return args;
  }

  async run(profile: RemoteProfile, remoteCommand: string, input?: string | Uint8Array, timeoutMs = 30_000): Promise<SshCommandResult> {
    const child = this.spawn(profile, remoteCommand);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = MAX_CAPTURE_BYTES - stdoutBytes;
      if (remaining > 0) {
        const kept = Buffer.from(chunk.subarray(0, remaining));
        stdoutChunks.push(kept);
        stdoutBytes += kept.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_CAPTURE_BYTES - stderrBytes;
      if (remaining > 0) {
        const kept = Buffer.from(chunk.subarray(0, remaining));
        stderrChunks.push(kept);
        stderrBytes += kept.length;
      }
    });
    const inputComplete = finishSshInput(child, input);
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    timeout.unref();
    let code: number;
    try {
      const [[exitCode]] = await Promise.all([
        once(child, "close") as Promise<[number | null]>,
        inputComplete
      ]);
      code = exitCode ?? 255;
    } catch (error) {
      child.kill();
      throw mapSshFailure(error, Buffer.concat(stderrChunks).toString("utf8"), profile);
    } finally {
      clearTimeout(timeout);
    }
    return { code, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderr: Buffer.concat(stderrChunks).toString("utf8") };
  }

  async probe(profile: RemoteProfile): Promise<RemoteProbe> {
    const script = [
      "set -eu",
      "platform=$(uname -s 2>/dev/null || printf unknown)",
      "arch=$(uname -m 2>/dev/null || printf unknown)",
      "libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || printf unknown)",
      "home_write=no; test -d \"$HOME\" && test -w \"$HOME\" && home_write=yes",
      "tar_ok=no; command -v tar >/dev/null 2>&1 && tar_ok=yes",
      "sha_ok=no; command -v sha256sum >/dev/null 2>&1 && sha_ok=yes",
      "printf 'PI_REMOTE_PROBE/1|%s|%s|%s|%s|%s|%s\\n' \"$platform\" \"$arch\" \"$libc\" \"$home_write\" \"$tar_ok\" \"$sha_ok\""
    ].join("\n");
    const result = await this.run(profile, "sh -s", script, 20_000);
    if (result.code !== 0) throw mapSshFailure(undefined, result.stderr, profile, result.code);
    const normalized = result.stdout.replace(/\r\n/gu, "\n").trimEnd();
    const lines = normalized.split("\n");
    if (lines.length !== 1 || !lines[0]!.startsWith("PI_REMOTE_PROBE/1|")) {
      throw new PiRemoteError("remote-shell-output-contaminated", "Remote shell printed unexpected data before the bootstrap probe.", {
        phase: "probe",
        remediation: "Remove output from non-interactive shell startup files such as .bashrc or ~/.ssh/rc.",
        safeDetails: { sample: redactDiagnostic(normalized).slice(0, 240) }
      });
    }
    const [, platform, arch, libc, homeWritable, tar, sha256sum] = lines[0]!.split("|");
    return {
      platform: platform || "unknown",
      arch: arch || "unknown",
      libc: libc || "unknown",
      homeWritable: homeWritable === "yes",
      tar: tar === "yes",
      sha256sum: sha256sum === "yes"
    };
  }

  async forwardingCheck(profile: RemoteProfile, remotePort: number): Promise<DoctorCheck> {
    const argsProfile: RemoteProfile = structuredClone(profile);
    const child = this.spawn(argsProfile, "printf 'PI_REMOTE_FORWARD/1\\n'", {
      remoteForward: { remotePort, localHost: "127.0.0.1", localPort: 9 }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.end();
    const [code] = await once(child, "close") as [number | null];
    if (code === 0 && stdout.trim() === "PI_REMOTE_FORWARD/1") {
      return { id: "remote-forwarding", status: "pass", message: "OpenSSH remote forwarding is available." };
    }
    return {
      id: "remote-forwarding",
      status: "fail",
      message: "OpenSSH remote forwarding is disabled or unavailable.",
      details: { diagnostic: redactDiagnostic(stderr).slice(0, 240) }
    };
  }
}

function finishSshInput(child: ChildProcessWithoutNullStreams, input?: string | Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.stdin.off("error", onInputError);
      child.off("close", onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onInputError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("SSH closed before command input was accepted."));
    child.stdin.once("error", onInputError);
    child.once("close", onClose);
    try {
      if (input !== undefined) child.stdin.end(input, () => finish());
      else child.stdin.end(() => finish());
    } catch (error) {
      finish(error as Error);
    }
  });
}

export function shellQuote(value: string): string {
  if (/[\0\r\n]/u.test(value)) throw new PiRemoteError("shell-argument-invalid", "Remote shell argument contains a control character.", { phase: "ssh" });
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function remoteRootShellExpression(profile: RemoteProfile): string {
  return profile.remoteRoot ? shellQuote(profile.remoteRoot) : '"${XDG_DATA_HOME:-$HOME/.local/share}/pi-remote"';
}

function mapSshFailure(error: unknown, stderr: string, profile: RemoteProfile, code?: number): PiRemoteError {
  const lower = stderr.toLocaleLowerCase();
  let failureCode = "ssh-failed";
  let remediation = "Verify the SSH host entry and run ssh manually for a detailed diagnosis.";
  if (lower.includes("permission denied") || lower.includes("authentication failed")) {
    failureCode = "ssh-auth-failed";
    remediation = "Configure key or ssh-agent authentication for the profile's OpenSSH host.";
  } else if (lower.includes("connection timed out") || lower.includes("no route to host") || lower.includes("could not resolve hostname") || lower.includes("connection refused")) {
    failureCode = "ssh-unreachable";
    remediation = "Verify hostname, port, ProxyJump, routing, and that sshd is running.";
  }
  return new PiRemoteError(failureCode, `SSH connection to ${profile.name} failed.`, {
    phase: "ssh",
    retryable: failureCode === "ssh-unreachable",
    remediation,
    safeDetails: { exitCode: code ?? null, diagnostic: redactDiagnostic(stderr).slice(0, 400) },
    cause: error
  });
}

export function redactDiagnostic(value: string): string {
  return value
    .replace(/((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;"'}]+/giu, "$1<redacted>")
    .replace(/(authorization|proxy-authorization|api[-_ ]?key|token|secret)\s*[:=]\s*[^\s]+/giu, "$1=<redacted>")
    .replace(/https?:\/\/[^\s:@/]+:[^\s@/]+@/giu, "http://<redacted>@");
}
