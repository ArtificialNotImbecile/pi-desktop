import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RemoteConnectionCreateRequest, RemoteConnectionRecord } from "../../shared/ipc.js";

export type SshExecOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  onData?(chunk: Buffer): void;
};

export type SshExecResult = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
};

export type RemoteImportCandidate = RemoteConnectionCreateRequest & {
  configPath: string;
  configHost: string;
  source: "vscode";
};

export async function discoverRemoteConnectionsFromSshConfig(): Promise<{ candidates: RemoteImportCandidate[]; scannedPaths: string[] }> {
  const configPaths = await discoverSshConfigPaths();
  const candidates: RemoteImportCandidate[] = [];
  for (const configPath of configPaths) {
    const parsed = await parseSshConfig(configPath).catch(() => []);
    candidates.push(...parsed);
  }
  return { candidates: dedupeCandidates(candidates), scannedPaths: configPaths };
}

export async function testRemoteConnection(connection: RemoteConnectionRecord): Promise<{ remotePath: string }> {
  const output = await sshExec(connection, "pwd", { timeoutMs: 8000 });
  const remotePath = output.toString("utf8").trim();
  if (!remotePath) throw new Error("SSH connected but did not return a working directory.");
  return { remotePath };
}

export function remoteLabel(connection: RemoteConnectionRecord): string {
  const target = connection.configHost || [connection.user, connection.host].filter(Boolean).join("@");
  return `${target}${connection.remotePath ? `:${connection.remotePath}` : ""}`;
}

export function sshExec(connection: RemoteConnectionRecord, command: string, options: SshExecOptions = {}): Promise<Buffer> {
  return sshExecWithStatus(connection, command, options).then((result) => {
    if (result.exitCode !== 0) {
      throw new Error(`SSH failed (${result.exitCode}): ${result.stderr.toString("utf8").trim()}`);
    }
    return result.stdout;
  });
}

export function sshExecWithStatus(connection: RemoteConnectionRecord, command: string, options: SshExecOptions = {}): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const args = sshArgs(connection, command);
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;
    const onAbort = () => child.kill();

    child.stdout.on("data", (data: Buffer) => {
      chunks.push(data);
      options.onData?.(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      errorChunks.push(data);
      options.onData?.(data);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) reject(new Error("aborted"));
      else if (timedOut) reject(new Error(`SSH timed out after ${options.timeoutMs}ms.`));
      else {
        resolve({
          stdout: Buffer.concat(chunks),
          stderr: Buffer.concat(errorChunks),
          exitCode: code ?? 1
        });
      }
    });
  });
}

export function sshArgs(connection: RemoteConnectionRecord, command: string): string[] {
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"];
  if (connection.configPath) args.push("-F", connection.configPath);
  if (connection.port && !connection.configHost) args.push("-p", String(connection.port));
  args.push(sshTarget(connection), command);
  return args;
}

export function sshTarget(connection: RemoteConnectionRecord): string {
  if (connection.configHost) return connection.configHost;
  return `${connection.user ? `${connection.user}@` : ""}${connection.host}`;
}

async function discoverSshConfigPaths(): Promise<string[]> {
  const paths = [
    process.env.JASMINE_E2E_SSH_CONFIG_FILE,
    process.env.VSCODE_REMOTE_SSH_CONFIG_FILE,
    ...(await vscodeConfiguredSshPaths()),
    path.join(os.homedir(), ".ssh", "config")
  ]
    .filter((item): item is string => Boolean(item?.trim()))
    .map(expandPath);
  return Array.from(new Set(paths)).filter((item) => existsSync(item));
}

async function vscodeConfiguredSshPaths(): Promise<string[]> {
  const settingsFiles = [
    path.join(process.env.APPDATA ?? "", "Code", "User", "settings.json"),
    path.join(process.env.APPDATA ?? "", "Code - Insiders", "User", "settings.json"),
    path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "settings.json"),
    path.join(os.homedir(), "AppData", "Roaming", "Code - Insiders", "User", "settings.json")
  ].filter((item) => item && existsSync(item));
  const paths: string[] = [];
  for (const file of settingsFiles) {
    try {
      const json = JSON.parse(stripJsonComments(await readFile(file, "utf8"))) as Record<string, unknown>;
      const configured = json["remote.SSH.configFile"] ?? json["remote.SSH.configFile.windows"];
      if (typeof configured === "string" && configured.trim()) paths.push(configured);
    } catch {
      // Ignore malformed editor settings; the default ~/.ssh/config still applies.
    }
  }
  return paths;
}

async function parseSshConfig(configPath: string): Promise<RemoteImportCandidate[]> {
  const content = await readFile(configPath, "utf8");
  const blocks: Array<{ hosts: string[]; options: Map<string, string> }> = [];
  let current: { hosts: string[]; options: Map<string, string> } | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(/\s+/);
    const key = rawKey.toLowerCase();
    const value = rest.join(" ").trim();
    if (key === "host") {
      current = { hosts: value.split(/\s+/).filter(Boolean), options: new Map() };
      blocks.push(current);
    } else if (current) {
      current.options.set(key, unquote(value));
    }
  }

  const candidates: RemoteImportCandidate[] = [];
  for (const block of blocks) {
    for (const alias of block.hosts) {
      if (isPatternHost(alias)) continue;
      const hostName = block.options.get("hostname") || alias;
      candidates.push({
        name: alias,
        host: hostName,
        user: block.options.get("user"),
        port: numberOption(block.options.get("port")),
        configHost: alias,
        configPath,
        source: "vscode"
      });
    }
  }
  return candidates;
}

function dedupeCandidates(candidates: RemoteImportCandidate[]): RemoteImportCandidate[] {
  const seen = new Set<string>();
  const result: RemoteImportCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.configPath}:${candidate.configHost}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function isPatternHost(host: string): boolean {
  return host === "*" || host.includes("*") || host.includes("?");
}

function numberOption(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

function expandPath(value: string): string {
  let next = value.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  next = next.replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? "");
  return path.resolve(next);
}

function stripJsonComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
