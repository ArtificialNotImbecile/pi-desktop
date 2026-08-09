import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

export const NATIVE_HOST_NAME = "com.jasmine.chrome";
export const BUNDLED_CHROME_EXTENSION_ID = "acmkogchlihbjohfionenaficgcljdjk";

export function deriveExtensionIdFromKey(keyBase64: string): string {
  const der = Buffer.from(keyBase64, "base64");
  const idBytes = createHash("sha256").update(der).digest().subarray(0, 16);
  let id = "";
  for (const byte of idBytes) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

export type ChromeTakeoverStatus = {
  bridgeRunning: boolean;
  extensionConnected: boolean;
  extensionResponsive: boolean;
  hostRegistered: boolean;
  extensionId: string | null;
  extensionPath: string | null;
  bridgePort: number | null;
};

type AgentPendingRequest = {
  kind: "agent";
  socket: Socket;
  extensionSocket: Socket;
  requestId: number | string;
};

type HealthPendingRequest = {
  kind: "health";
  extensionSocket: Socket;
  timer: ReturnType<typeof setTimeout>;
  resolve: (responsive: boolean) => void;
};

type PendingRequest = AgentPendingRequest | HealthPendingRequest;

// The native host reads this same default path, so the app must publish the
// bridge port and token here (or at JASMINE_CHROME_BRIDGE_FILE for tests).
export function bridgeInfoFilePath(): string {
  if (process.env.JASMINE_CHROME_BRIDGE_FILE) return process.env.JASMINE_CHROME_BRIDGE_FILE;
  return path.join(homedir(), ".jasmine", "chrome-bridge.json");
}

export function resolveChromeExtensionRoot(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packagedResourcesRoot = typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  const candidates = [
    process.env.JASMINE_CHROME_EXTENSION_ROOT,
    packagedResourcesRoot ? path.resolve(packagedResourcesRoot, "jasmine-resources", "chrome-extension") : null,
    path.resolve(process.cwd(), "resources", "chrome-extension"),
    path.resolve(moduleDir, "..", "..", "..", "..", "resources", "chrome-extension"),
    path.resolve(moduleDir, "..", "..", "..", "resources", "chrome-extension")
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "manifest.json"))) return candidate;
  }
  return null;
}

export function buildNativeHostManifest(extensionId: string, launcherPath: string): Record<string, unknown> {
  return {
    name: NATIVE_HOST_NAME,
    description: "Jasmine Chrome control native messaging host.",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
}

// Chrome native messaging manifests must point at a single executable with no
// args, so we generate a launcher that runs Electron as Node against the host
// script. Returns the launcher filename and contents for the current platform.
export function launcherScriptFor(electronExe: string, hostScript: string): { filename: string; contents: string; executable: boolean } {
  if (process.platform === "win32") {
    return {
      filename: "jasmine-chrome-host.cmd",
      contents: `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electronExe}" "${hostScript}" %*\r\n`,
      executable: false
    };
  }
  return {
    filename: "jasmine-chrome-host.sh",
    contents: `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${electronExe}" "${hostScript}" "$@"\n`,
    executable: true
  };
}

// Per-user native messaging manifest locations for Chrome and Edge.
export function nativeHostManifestTargets(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    return [
      path.join(base, "Google", "Chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
      path.join(base, "Microsoft Edge", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`)
    ];
  }
  if (process.platform === "linux") {
    const base = path.join(home, ".config");
    return [
      path.join(base, "google-chrome", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`),
      path.join(base, "microsoft-edge", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`)
    ];
  }
  // Windows registers via the registry, not a shared dir; keep one on-disk copy.
  return [];
}

export function windowsRegistryTargets(): string[] {
  return [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
  ];
}

function runReg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("reg.exe", args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`reg.exe exited ${code}: ${stderr.trim()}`))));
  });
}

function runRegDelete(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("reg.exe", args, { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || /unable to find the specified registry key/i.test(output)) {
        resolve();
        return;
      }
      reject(new Error(`reg.exe exited ${code}: ${output.trim()}`));
    });
  });
}

export class ChromeBridge {
  private server: Server | null = null;
  private port: number | null = null;
  private token = "";
  private extensionSocket: Socket | null = null;
  private extensionResponsive = false;
  private extensionResponseVersion = 0;
  private hostRegistered = false;
  private extensionId: string | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly userDataDir: string) {}

  async start(): Promise<ChromeTakeoverStatus> {
    if (this.server) return this.status();
    this.token = randomBytes(24).toString("hex");
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        this.server = server;
        this.port = (server.address() as { port: number }).port;
        resolve();
      });
    });
    await this.publishBridgeInfo();
    return this.status();
  }

  async stop(): Promise<void> {
    for (const socket of [this.extensionSocket]) socket?.destroy();
    this.extensionSocket = null;
    this.extensionResponsive = false;
    this.failPendingForExtension();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
    this.port = null;
  }

  async cleanup(): Promise<void> {
    await this.stop();
    await rm(bridgeInfoFilePath(), { force: true }).catch(() => undefined);
  }

  status(): ChromeTakeoverStatus {
    return {
      bridgeRunning: Boolean(this.server),
      extensionConnected: Boolean(this.extensionSocket),
      extensionResponsive: Boolean(this.extensionSocket) && this.extensionResponsive,
      hostRegistered: this.hostRegistered,
      extensionId: this.extensionId ?? BUNDLED_CHROME_EXTENSION_ID,
      extensionPath: resolveChromeExtensionRoot(),
      bridgePort: this.port
    };
  }

  async refreshExtensionHealth(timeoutMs = 1000): Promise<ChromeTakeoverStatus> {
    const extensionSocket = this.extensionSocket;
    if (!extensionSocket || extensionSocket.destroyed) {
      this.extensionResponsive = false;
      return this.status();
    }

    const bridgeId = this.nextRequestId++;
    const responseVersion = this.extensionResponseVersion;
    const responsive = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(bridgeId);
        if (pending?.kind !== "health") return;
        this.pending.delete(bridgeId);
        if (this.extensionSocket === extensionSocket && this.extensionResponseVersion === responseVersion) {
          this.extensionResponsive = false;
        }
        resolve(false);
      }, Math.max(1, timeoutMs));
      this.pending.set(bridgeId, { kind: "health", extensionSocket, timer, resolve });
      extensionSocket.write(`${JSON.stringify({ id: bridgeId, method: "status", params: {} })}\n`);
    });
    if (responsive && this.extensionSocket === extensionSocket) this.extensionResponsive = true;
    return this.status();
  }

  private async publishBridgeInfo(): Promise<void> {
    const file = bridgeInfoFilePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ port: this.port, token: this.token }), "utf8");
  }

  private onConnection(socket: Socket): void {
    let buffer = "";
    let authorized = false;
    let role: string | null = null;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line);
          } catch {
            newlineIndex = buffer.indexOf("\n");
            continue;
          }
          if (!authorized) {
            if (message.type === "hello" && message.token === this.token && typeof message.role === "string") {
              authorized = true;
              role = message.role;
              if (role === "chrome-extension") this.attachExtension(socket);
            } else {
              socket.destroy();
              return;
            }
          } else if (role === "chrome-extension") {
            this.onExtensionMessage(message);
          } else if (role === "agent") {
            this.onAgentMessage(socket, message);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      if (this.extensionSocket === socket) {
        this.extensionSocket = null;
        this.extensionResponsive = false;
        this.failPendingForExtension(socket);
      }
      for (const [id, pending] of this.pending) {
        if (pending.kind === "agent" && pending.socket === socket) this.pending.delete(id);
      }
    });
    socket.on("error", () => socket.destroy());
  }

  private attachExtension(socket: Socket): void {
    const previousSocket = this.extensionSocket;
    if (previousSocket && previousSocket !== socket) {
      this.failPendingForExtension(previousSocket);
      previousSocket.destroy();
    }
    this.extensionSocket = socket;
    this.extensionResponsive = false;
    void this.refreshExtensionHealth();
  }

  // Extension -> agent: route the reply back to the waiting agent by bridge id.
  private onExtensionMessage(message: Record<string, unknown>): void {
    const bridgeId = Number(message.id);
    if (!Number.isInteger(bridgeId)) return;
    const pending = this.pending.get(bridgeId);
    if (!pending) return;
    this.pending.delete(bridgeId);
    this.extensionResponseVersion += 1;
    this.extensionResponsive = true;
    if (pending.kind === "health") {
      clearTimeout(pending.timer);
      pending.resolve(true);
      return;
    }
    const reply = { ...message, id: pending.requestId };
    delete (reply as { __bridgeId?: number }).__bridgeId;
    if (!pending.socket.destroyed) pending.socket.write(`${JSON.stringify(reply)}\n`);
  }

  // Agent -> extension: use the bridge id as the protocol id, then restore the
  // agent's original id when the extension reply returns.
  private onAgentMessage(socket: Socket, message: Record<string, unknown>): void {
    if (!this.extensionSocket) {
      socket.write(`${JSON.stringify({ id: message.id, ok: false, error: "Chrome extension is not connected." })}\n`);
      return;
    }
    const bridgeId = this.nextRequestId++;
    const extensionSocket = this.extensionSocket;
    this.pending.set(bridgeId, { kind: "agent", socket, extensionSocket, requestId: message.id as number | string });
    const request = { ...message, id: bridgeId };
    delete (request as { __bridgeId?: number }).__bridgeId;
    extensionSocket.write(`${JSON.stringify(request)}\n`);
  }

  private failPendingForExtension(extensionSocket?: Socket): void {
    for (const [bridgeId, pending] of this.pending) {
      if (extensionSocket && pending.extensionSocket !== extensionSocket) continue;
      this.pending.delete(bridgeId);
      if (pending.kind === "health") {
        clearTimeout(pending.timer);
        pending.resolve(false);
      } else if (!pending.socket.destroyed) {
        pending.socket.write(`${JSON.stringify({
          id: pending.requestId,
          ok: false,
          error: "Chrome extension disconnected before replying."
        })}\n`);
      }
    }
  }

  async registerNativeHost(extensionId?: string): Promise<ChromeTakeoverStatus> {
    const trimmed = extensionId?.trim().toLowerCase() || BUNDLED_CHROME_EXTENSION_ID;
    if (!/^[a-p]{32}$/.test(trimmed)) {
      throw new Error("Enter a valid 32-character Chrome extension ID.");
    }
    const extensionRoot = resolveChromeExtensionRoot();
    if (!extensionRoot) throw new Error("Bundled Jasmine Chrome extension was not found.");
    const hostScript = path.join(extensionRoot, "native-host", "jasmine-chrome-host.mjs");
    const bridgeDir = path.join(this.userDataDir, "chrome-bridge");
    await mkdir(bridgeDir, { recursive: true });

    const launcher = launcherScriptFor(process.execPath, hostScript);
    const launcherPath = path.join(bridgeDir, launcher.filename);
    await writeFile(launcherPath, launcher.contents, "utf8");
    if (launcher.executable) await chmod(launcherPath, 0o755);

    const manifest = buildNativeHostManifest(trimmed, launcherPath);
    const manifestPath = path.join(bridgeDir, `${NATIVE_HOST_NAME}.json`);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    if (!skipExternalNativeHostRegistration()) {
      if (process.platform === "win32") {
        for (const key of windowsRegistryTargets()) {
          await runReg(["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
        }
      } else {
        for (const target of nativeHostManifestTargets()) {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, JSON.stringify(manifest, null, 2), "utf8");
        }
      }
    }

    this.extensionId = trimmed;
    this.hostRegistered = true;
    return this.refreshExtensionHealth();
  }

  async unregisterNativeHost(): Promise<ChromeTakeoverStatus> {
    if (!skipExternalNativeHostRegistration()) {
      if (process.platform === "win32") {
        for (const key of windowsRegistryTargets()) {
          await runRegDelete(["delete", key, "/f"]);
        }
      } else {
        for (const target of nativeHostManifestTargets()) {
          await rm(target, { force: true });
        }
      }
    }

    this.hostRegistered = false;
    this.extensionId = null;
    return this.status();
  }
}

function skipExternalNativeHostRegistration(): boolean {
  return process.env.JASMINE_E2E_MOCK_AI === "1" || process.env.JASMINE_CHROME_SKIP_EXTERNAL_REGISTRATION === "1";
}

let sharedBridge: ChromeBridge | null = null;

export async function getChromeBridge(userDataDir: string): Promise<ChromeBridge> {
  if (!sharedBridge) {
    sharedBridge = new ChromeBridge(userDataDir);
    await sharedBridge.start();
  }
  return sharedBridge;
}

export async function stopChromeBridge(): Promise<void> {
  await sharedBridge?.cleanup();
}
