#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { PiRemoteError } from "./errors.js";
import { loadLocalPiModelConfig } from "./config.js";
import { ProfileStore } from "./profiles.js";
import { ManagedRemoteRuntime } from "./runtime.js";
import { shellQuote } from "./ssh.js";
import type { DoctorReport, RemoteProfile, RemoteSessionEvent } from "./types.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  stdin: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  isTTY: boolean;
}

export interface CliDependencies {
  store?: ProfileStore;
  runtime?: ManagedRemoteRuntime;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdin: process.stdin,
  output: process.stdout,
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY)
};

if (isMainModule()) {
  void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

export async function runCli(argv: string[], io: CliIo = defaultIo, dependencies: CliDependencies = {}): Promise<number> {
  const separator = argv.indexOf("--");
  const json = argv.some((arg, index) => arg === "--json" && (separator < 0 || index < separator));
  const args = argv.filter((arg, index) => arg !== "--json" || separator >= 0 && index > separator);
  const [group, command, ...rest] = args;
  const store = dependencies.store ?? new ProfileStore();
  const runtime = dependencies.runtime ?? new ManagedRemoteRuntime();
  try {
    if (!group || group === "help" || group === "--help" || group === "-h") {
      io.stdout(helpText());
      return 0;
    }
    if (group === "profile") return await profileCommand(store, command, rest, io, json);
    if (group === "doctor") {
      const profile = await store.get(requiredPositional(command, "profile"));
      const report = await runtime.doctor(profile);
      printDoctor(report, io, json);
      return report.ok ? 0 : 1;
    }
    if (group === "connect") {
      const profile = await store.get(requiredPositional(command, "profile"));
      return await runtime.openTui(profile, {
        cwd: option(rest, "--cwd"),
        continueSession: flag(rest, "--continue"),
        resume: flag(rest, "--resume"),
        sessionId: option(rest, "--session"),
        piArgs: afterDoubleDash(rest)
      });
    }
    if (group === "prompt") return await promptCommand(runtime, store, command, rest, io, json);
    if (group === "shell") return await shellCommand(runtime, store, command, rest, io, json);
    if (group === "sessions" && command === "list") return await sessionsCommand(runtime, store, rest, io, json);
    if (group === "runtime") return await runtimeCommand(runtime, store, command, rest, io, json);
    if (group === "auth") return await authCommand(runtime, store, command, rest, io, json);
    if (group === "config") return await configCommand(runtime, store, command, rest, io, json);
    if (group === "file") return await fileCommand(runtime, store, command, rest, io, json);
    if (group === "stop") {
      const profile = await store.get(requiredPositional(command, "profile"));
      await runtime.stop(profile);
      printValue({ stopped: true, profile: profile.name }, io, json);
      return 0;
    }
    throw new PiRemoteError("cli-command-invalid", `Unknown command ${[group, command].filter(Boolean).join(" ")}.`, {
      phase: "profile",
      remediation: "Run `pi-remote help`."
    });
  } catch (error) {
    const normalized = error instanceof PiRemoteError
      ? error
      : new PiRemoteError("cli-failed", error instanceof Error ? error.message : String(error), { phase: "runtime", cause: error });
    if (json) io.stderr(`${JSON.stringify({ error: normalized.serialize() })}\n`);
    else {
      io.stderr(`Error [${normalized.code}]: ${normalized.message}\n`);
      if (normalized.remediation) io.stderr(`${normalized.remediation}\n`);
    }
    return 1;
  }
}

async function profileCommand(store: ProfileStore, command: string | undefined, args: string[], io: CliIo, json: boolean): Promise<number> {
  if (command === "add") {
    const name = requiredPositional(args[0], "profile name");
    const networkMode = option(args, "--network");
    if (networkMode !== undefined && networkMode !== "remote-direct" && networkMode !== "client-proxy") {
      throw new PiRemoteError("network-mode-invalid", `Unsupported network mode ${networkMode}.`, {
        phase: "profile",
        remediation: "Use --network remote-direct or --network client-proxy."
      });
    }
    const profile = await store.add({
      name,
      sshHost: requiredOption(args, "--host"),
      ...(option(args, "--port") ? { sshPort: parsePort(option(args, "--port")!) } : {}),
      ...(option(args, "--cwd") ? { defaultCwd: option(args, "--cwd") } : {}),
      ...(option(args, "--remote-root") ? { remoteRoot: option(args, "--remote-root") } : {}),
      networkMode: networkMode ?? "remote-direct",
      noProxy: splitList(option(args, "--no-proxy")),
      allowedPorts: option(args, "--allow-port") ? splitList(option(args, "--allow-port")).map(parsePort) : [80, 443],
      ...(option(args, "--upstream-proxy-env") ? { upstreamProxyEnv: option(args, "--upstream-proxy-env") } : {})
    });
    printValue(profile, io, json);
    return 0;
  }
  if (command === "list") {
    printValue(await store.list(), io, json);
    return 0;
  }
  if (command === "show") {
    printValue(await store.get(requiredPositional(args[0], "profile")), io, json);
    return 0;
  }
  if (command === "remove") {
    const removed = await store.remove(requiredPositional(args[0], "profile"));
    printValue({ removed: removed.name, remoteDataPreserved: true }, io, json);
    return 0;
  }
  throw new PiRemoteError("cli-command-invalid", "Usage: pi-remote profile add|list|show|remove", { phase: "profile" });
}

async function runtimeCommand(runtime: ManagedRemoteRuntime, store: ProfileStore, command: string | undefined, args: string[], io: CliIo, json: boolean): Promise<number> {
  const profile = await store.get(requiredPositional(args[0], "profile"));
  if (command === "status") {
    const report = await runtime.doctor(profile);
    printDoctor(report, io, json);
    return report.ok ? 0 : 1;
  }
  if (command === "install" || command === "upgrade") {
    const info = await runtime.ensureRuntime(profile);
    printValue(info, io, json);
    return 0;
  }
  throw new PiRemoteError("cli-command-invalid", "Usage: pi-remote runtime status|install|upgrade <profile>", { phase: "runtime" });
}

async function sessionsCommand(runtime: ManagedRemoteRuntime, store: ProfileStore, args: string[], io: CliIo, json: boolean): Promise<number> {
  const profile = await store.get(requiredPositional(args[0], "profile"));
  printValue(await runtime.listSessions(profile), io, json);
  return 0;
}

async function promptCommand(runtime: ManagedRemoteRuntime, store: ProfileStore, profileArg: string | undefined, args: string[], io: CliIo, json: boolean): Promise<number> {
  const profile = await store.get(requiredPositional(profileArg, "profile"));
  const text = requiredOption(args, "--text");
  const sessionId = option(args, "--session");
  const images = await Promise.all(options(args, "--image").map(async (filePath) => ({
    data: (await readFile(filePath)).toString("base64"),
    mimeType: mimeType(filePath)
  })));
  const port = await runtime.openSession(profile, { cwd: option(args, "--cwd") ?? profile.defaultCwd, ...(sessionId ? { sessionId } : {}) });
  const settled = waitForSettled(port, io, json);
  try {
    if (!sessionId) await port.createSession(option(args, "--cwd") ?? profile.defaultCwd!);
    await port.prompt(text, images);
    await settled.promise;
  } catch (error) {
    settled.cancel();
    await settled.promise.catch(() => {});
    throw error;
  } finally {
    settled.cancel();
    await port.close({ abort: false });
  }
  return 0;
}

async function shellCommand(runtime: ManagedRemoteRuntime, store: ProfileStore, profileArg: string | undefined, args: string[], io: CliIo, json: boolean): Promise<number> {
  const profile = await store.get(requiredPositional(profileArg, "profile"));
  const separator = args.indexOf("--");
  const command = (separator >= 0 ? args.slice(separator + 1) : args).map(shellQuote).join(" ");
  if (!command.trim()) throw new PiRemoteError("shell-command-required", "A command after -- is required.", { phase: "session" });
  const port = await runtime.openSession(profile, { cwd: option(args, "--cwd") ?? profile.defaultCwd });
  try { printValue(await port.bash(command), io, json); }
  finally { await port.close({ abort: false }); }
  return 0;
}

async function authCommand(runtime: ManagedRemoteRuntime, store: ProfileStore, command: string | undefined, args: string[], io: CliIo, json: boolean): Promise<number> {
  const profile = await store.get(requiredPositional(args[0], "profile"));
  const provider = option(args, "--provider");
  if (command === "list") {
    printValue(await runtime.authList(profile), io, json);
    return 0;
  }
  if (!provider) throw new PiRemoteError("provider-required", "--provider is required.", { phase: "auth" });
  if (command === "import") {
    const agentDir = option(args, "--from-agent-dir") || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const auth = JSON.parse(await readFile(path.join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
    if (!Object.hasOwn(auth, provider)) throw new PiRemoteError("credential-not-found", `No local credential is stored for ${provider}.`, { phase: "auth" });
    if (!flag(args, "--yes") && !await confirm(io, `Copy the ${provider} credential into isolated remote profile ${profile.name}?`)) return 2;
    await runtime.authImport(profile, provider, auth[provider]);
    printValue({ imported: provider, profile: profile.name }, io, json);
    return 0;
  }
  if (command === "remove") {
    await runtime.authRemove(profile, provider);
    printValue({ removed: provider, profile: profile.name }, io, json);
    return 0;
  }
  throw new PiRemoteError("cli-command-invalid", "Usage: pi-remote auth list|import|remove <profile> [--provider ID]", { phase: "auth" });
}

async function configCommand(runtime: ManagedRemoteRuntime, store: ProfileStore, command: string | undefined, args: string[], io: CliIo, json: boolean): Promise<number> {
  if (command !== "sync") throw new PiRemoteError("cli-command-invalid", "Usage: pi-remote config sync <profile> [--from-agent-dir PATH]", { phase: "config" });
  const profile = await store.get(requiredPositional(args[0], "profile"));
  const agentDir = option(args, "--from-agent-dir") || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const config = await loadLocalPiModelConfig(agentDir);
  if (!flag(args, "--yes") && !await confirm(io, `Copy local models.json and model defaults into isolated remote profile ${profile.name}?`, "config")) return 2;
  const result = await runtime.syncModelConfig(profile, config);
  printValue({ profile: profile.name, ...result }, io, json);
  return 0;
}

async function fileCommand(runtime: ManagedRemoteRuntime, store: ProfileStore, command: string | undefined, args: string[], io: CliIo, json: boolean): Promise<number> {
  const profile = await store.get(requiredPositional(args[0], "profile"));
  if (command === "put") {
    const localPath = requiredPositional(args[1], "local path");
    const remotePath = requiredOption(args, "--to");
    printValue(await runtime.putFile(profile, localPath, remotePath, flag(args, "--force")), io, json);
    return 0;
  }
  if (command === "get") {
    const remotePath = requiredPositional(args[1], "remote path");
    const localPath = requiredOption(args, "--to");
    await runtime.getFile(profile, remotePath, localPath, flag(args, "--force"));
    printValue({ downloaded: remotePath, to: path.resolve(localPath) }, io, json);
    return 0;
  }
  throw new PiRemoteError("cli-command-invalid", "Usage: pi-remote file put|get <profile> <path> --to <path>", { phase: "file" });
}

function waitForSettled(port: { readonly eventCursor?: number; subscribe(listener: (event: RemoteSessionEvent) => void): () => void }, io: CliIo, json: boolean): { promise: Promise<void>; cancel(): void } {
  const cutoff = port.eventCursor ?? 0;
  let cancel = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    let done = false;
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      done = true;
      unsubscribe();
      reject(new PiRemoteError("prompt-timeout", "Remote prompt did not settle within 30 minutes.", { phase: "session", retryable: true }));
    }, 30 * 60_000);
    timer.unref();
    unsubscribe = port.subscribe((event) => {
      if (event.seq <= cutoff) return;
      if (json) io.stdout(`${JSON.stringify(event)}\n`);
      const raw = event.type === "rpc.message" && event.data && typeof event.data === "object" ? event.data as Record<string, any> : undefined;
      if (!json && raw?.type === "message_update" && raw.assistantMessageEvent?.type === "text_delta") io.stdout(String(raw.assistantMessageEvent.delta || ""));
      if (raw?.type === "agent_settled") {
        done = true;
        clearTimeout(timer);
        unsubscribe();
        if (!json) io.stdout("\n");
        resolve();
      }
      if (event.type === "rpc.exit" || event.type === "transport.disconnected") {
        done = true;
        clearTimeout(timer);
        unsubscribe();
        reject(new PiRemoteError(
          event.type === "transport.disconnected" ? "daemon-disconnected" : "remote-process-exited",
          event.type === "transport.disconnected"
            ? "Remote daemon connection closed before the prompt settled."
            : "Remote Pi RPC process exited before the prompt settled.",
          { phase: event.type === "transport.disconnected" ? "protocol" : "session", retryable: true }
        ));
      }
    });
    cancel = () => {
      clearTimeout(timer);
      unsubscribe();
      if (!done) { done = true; resolve(); }
    };
    if (done) unsubscribe();
  });
  return { promise, cancel: () => cancel() };
}

function printDoctor(report: DoctorReport, io: CliIo, json: boolean): void {
  if (json) { io.stdout(`${JSON.stringify(report)}\n`); return; }
  io.stdout(`${report.profile.name} (${report.profile.sshHost}): ${report.ok ? "ready" : "not ready"}\n`);
  for (const check of report.checks) io.stdout(`${check.status === "pass" ? "PASS" : check.status.toUpperCase()}  ${check.id}: ${check.message}\n`);
}

function printValue(value: unknown, io: CliIo, json: boolean): void {
  if (json) { io.stdout(`${JSON.stringify(value)}\n`); return; }
  if (Array.isArray(value)) {
    if (value.length === 0) io.stdout("No entries.\n");
    else for (const entry of value) io.stdout(`${JSON.stringify(entry)}\n`);
    return;
  }
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

async function confirm(io: CliIo, prompt: string, phase: "auth" | "config" = "auth"): Promise<boolean> {
  if (!io.isTTY) throw new PiRemoteError("confirmation-required", `Non-interactive ${phase === "auth" ? "credential import" : "configuration sync"} requires --yes.`, { phase });
  const rl = createInterface({ input: io.stdin as NodeJS.ReadableStream & { isTTY?: boolean }, output: io.output });
  try { return /^(y|yes)$/iu.test((await rl.question(`${prompt} [y/N] `)).trim()); }
  finally { rl.close(); }
}

function option(args: string[], name: string): string | undefined {
  const scoped = beforeSeparator(args);
  const index = scoped.indexOf(name);
  return index >= 0 ? scoped[index + 1] : undefined;
}

function options(args: string[], name: string): string[] {
  args = beforeSeparator(args);
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name && args[index + 1]) values.push(args[index + 1]!);
  return values;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value || value.startsWith("--")) throw new PiRemoteError("cli-option-required", `${name} requires a value.`, { phase: "profile" });
  return value;
}

function requiredPositional(value: string | undefined, name: string): string {
  if (!value || value.startsWith("--")) throw new PiRemoteError("cli-argument-required", `${name} is required.`, { phase: "profile" });
  return value;
}

function flag(args: string[], name: string): boolean { return beforeSeparator(args).includes(name); }
function beforeSeparator(args: string[]): string[] { const index = args.indexOf("--"); return index < 0 ? args : args.slice(0, index); }
function splitList(value?: string): string[] { return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : []; }
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new PiRemoteError("port-invalid", `Invalid port ${value}.`, { phase: "profile" });
  return port;
}
function afterDoubleDash(args: string[]): string[] { const index = args.indexOf("--"); return index < 0 ? [] : args.slice(index + 1); }
function mimeType(filePath: string): string {
  const extension = path.extname(filePath).toLocaleLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  throw new PiRemoteError("image-type-unsupported", `Unsupported image type ${extension || "unknown"}.`, { phase: "file" });
}

function helpText(): string {
  return `pi-remote - managed isolated Pi runtimes over OpenSSH

Usage:
  pi-remote profile add <name> --host <ssh-alias> [--port N] [--cwd /path] [--network remote-direct|client-proxy]
  pi-remote profile list|show|remove
  pi-remote doctor <profile> [--json]
  pi-remote connect <profile> [--cwd /path] [--continue|--resume|--session ID] [-- <pi args>]
  pi-remote prompt <profile> --text <message> [--image FILE] [--json]
  pi-remote shell <profile> -- <command>
  pi-remote sessions list <profile>
  pi-remote runtime status|install|upgrade <profile>
  pi-remote auth list|import|remove <profile> [--provider ID]
  pi-remote config sync <profile> [--from-agent-dir PATH] [--yes]
  pi-remote file put|get <profile> <path> --to <path>
  pi-remote stop <profile>
`;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(path.resolve(entry)).href === import.meta.url);
}
