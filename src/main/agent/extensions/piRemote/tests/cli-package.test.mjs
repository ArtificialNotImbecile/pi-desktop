import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCli } from "../dist/cli.js";
import { parseRemoteArgs } from "../dist/extension.js";
import { ManagedRemoteRuntime, ProfileStore, resolveSessionForOpen } from "../dist/index.js";

test("Pi /remote preserves quoted and escaped working directories", () => {
  assert.deepEqual(parseRemoteArgs('prod --cwd "/srv/my project"'), { profile: "prod", cwd: "/srv/my project" });
  assert.deepEqual(parseRemoteArgs("--cwd '/srv/single quoted' prod"), { profile: "prod", cwd: "/srv/single quoted" });
  assert.deepEqual(parseRemoteArgs("prod --cwd /srv/escaped\\ path"), { profile: "prod", cwd: "/srv/escaped path" });
  assert.throws(() => parseRemoteArgs('prod --cwd "/srv/unfinished'), /unterminated quote/u);
  assert.throws(() => parseRemoteArgs("prod --cwd"), /requires a non-empty path/u);
});

test("CLI profile lifecycle is usable without network access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-cli-"));
  const previous = process.env.PI_REMOTE_CONFIG_PATH;
  process.env.PI_REMOTE_CONFIG_PATH = path.join(root, "profiles.json");
  const output = [];
  const errors = [];
  const io = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), stdin: process.stdin, output: process.stdout, isTTY: false };
  try {
    assert.equal(await runCli(["profile", "add", "test", "--host", "devbox", "--port", "2222", "--cwd", "/workspace", "--json"], io), 0);
    assert.equal(await runCli(["profile", "list", "--json"], io), 0);
    assert.match(output.join(""), /"sshPort":2222/u);
    assert.equal(await runCli(["profile", "remove", "test", "--json"], io), 0);
    assert.match(output.join(""), /"remoteDataPreserved":true/u);
    assert.deepEqual(errors, []);
  } finally {
    if (previous === undefined) delete process.env.PI_REMOTE_CONFIG_PATH;
    else process.env.PI_REMOTE_CONFIG_PATH = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI model config sync copies models and only portable model defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-config-sync-"));
  const agentDir = path.join(root, "agent");
  const store = new ProfileStore(path.join(root, "profiles.json"));
  const profile = await store.add({ name: "test", sshHost: "devbox" });
  let received;
  const runtime = {
    async syncModelConfig(value, config) {
      assert.equal(value.id, profile.id);
      received = config;
      return { synced: ["models.json", "settings.json"], providerCount: 1, settings: Object.keys(config.settings) };
    }
  };
  const output = []; const errors = [];
  const io = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), stdin: process.stdin, output: process.stdout, isTTY: false };
  try {
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "https://provider.example/v1" } } }));
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "fixture", defaultModel: "model-a", defaultThinkingLevel: "medium",
      packages: ["C:\\local-only"], skills: ["C:\\skills"], theme: "local-theme"
    }));
    assert.equal(await runCli(["config", "sync", "test", "--from-agent-dir", agentDir, "--yes", "--json"], io, { store, runtime }), 0);
    assert.deepEqual(received.models, { providers: { fixture: { baseUrl: "https://provider.example/v1" } } });
    assert.deepEqual(received.settings, { defaultProvider: "fixture", defaultModel: "model-a", defaultThinkingLevel: "medium" });
    assert.doesNotMatch(JSON.stringify(received), /local-only|local-theme|skills/u);
    assert.match(output.join(""), /"providerCount":1/u);
    assert.deepEqual(errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI rejects unknown network modes instead of silently selecting direct egress", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-cli-network-"));
  const store = new ProfileStore(path.join(root, "profiles.json"));
  const output = [];
  const errors = [];
  const io = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), stdin: process.stdin, output: process.stdout, isTTY: false };
  try {
    assert.equal(await runCli(["profile", "add", "test", "--host", "devbox", "--network", "client-prxoy", "--json"], io, { store }), 1);
    assert.match(errors.join(""), /"code":"network-mode-invalid"/u);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI sessions list uses daemon metadata without opening an RPC child or requiring cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-cli-sessions-"));
  const store = new ProfileStore(path.join(root, "profiles.json"));
  const profile = await store.add({ name: "test", sshHost: "devbox" });
  const calls = [];
  const runtime = {
    async listSessions(value) {
      calls.push({ method: "listSessions", profile: value });
      return [{ id: "session-a", cwd: "/workspace", createdAt: new Date(0).toISOString() }];
    },
    async openSession() { throw new Error("sessions list must not start RPC"); }
  };
  const output = [];
  const errors = [];
  const io = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), stdin: process.stdin, output: process.stdout, isTTY: false };
  try {
    assert.equal(await runCli(["sessions", "list", profile.name, "--json"], io, { store, runtime }), 0);
    assert.deepEqual(calls.map((entry) => entry.method), ["listSessions"]);
    assert.equal(calls[0].profile.defaultCwd, undefined);
    assert.match(output.join(""), /"id":"session-a"/u);
    assert.deepEqual(errors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI prompt rejects immediately when the session transport disconnects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-cli-disconnect-"));
  const store = new ProfileStore(path.join(root, "profiles.json"));
  const profile = await store.add({ name: "test", sshHost: "devbox", defaultCwd: "/workspace" });
  const listeners = new Set();
  const port = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async createSession() { return "session-a"; },
    async prompt() { queueMicrotask(() => { for (const listener of listeners) listener({ seq: 1, type: "transport.disconnected" }); }); },
    async close() {}
  };
  const runtime = { async openSession() { return port; } };
  const output = [];
  const errors = [];
  const io = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), stdin: process.stdin, output: process.stdout, isTTY: false };
  try {
    assert.equal(await runCli(["prompt", profile.name, "--text", "hello", "--json"], io, { store, runtime }), 1);
    assert.match(errors.join(""), /"code":"daemon-disconnected"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI prompt ignores replay events at or before its subscription cursor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-cli-replay-"));
  const store = new ProfileStore(path.join(root, "profiles.json"));
  await store.add({ name: "test", sshHost: "devbox", defaultCwd: "/workspace" });
  const listeners = new Set();
  const port = {
    eventCursor: 5,
    subscribe(listener) { listeners.add(listener); listener({ seq: 5, type: "rpc.message", data: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OLD" } } }); return () => listeners.delete(listener); },
    async createSession() { return "session-a"; },
    async prompt() { queueMicrotask(() => { for (const listener of listeners) { listener({ seq: 6, type: "rpc.message", data: { type: "agent_start" } }); listener({ seq: 7, type: "rpc.message", data: { type: "agent_end" } }); listener({ seq: 8, type: "rpc.message", data: { type: "agent_settled" } }); } }); },
    async close() {}
  };
  const output = []; const errors = [];
  const io = { stdout: (value) => output.push(value), stderr: (value) => errors.push(value), stdin: process.stdin, output: process.stdout, isTTY: false };
  try {
    assert.equal(await runCli(["prompt", "test", "--text", "hello", "--json"], io, { store, runtime: { async openSession() { return port; } } }), 0);
    assert.doesNotMatch(output.join(""), /OLD/u);
    assert.deepEqual(errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI disposes its settled waiter when session creation fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-cli-prefail-"));
  const store = new ProfileStore(path.join(root, "profiles.json"));
  await store.add({ name: "test", sshHost: "devbox", defaultCwd: "/workspace" });
  const listeners = new Set(); let unhandled;
  const onUnhandled = (error) => { unhandled = error; };
  process.on("unhandledRejection", onUnhandled);
  const port = {
    eventCursor: 0,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async createSession() { for (const listener of listeners) listener({ seq: 1, type: "transport.disconnected" }); throw new Error("fixture create failure"); },
    async close() {}
  };
  const io = { stdout() {}, stderr() {}, stdin: process.stdin, output: process.stdout, isTTY: false };
  try {
    assert.equal(await runCli(["prompt", "test", "--text", "hello"], io, { store, runtime: { async openSession() { return port; } } }), 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
    assert.equal(listeners.size, 0);
  } finally { process.off("unhandledRejection", onUnhandled); await rm(root, { recursive: true, force: true }); }
});

test("CLI preserves --json arguments after the shell separator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-cli-separator-"));
  const store = new ProfileStore(path.join(root, "profiles.json"));
  await store.add({ name: "test", sshHost: "devbox", defaultCwd: "/workspace" });
  let received = "";
  let openedCwd = "";
  const port = { async bash(command) { received = command; return { output: "ok" }; }, async close() {} };
  const io = { stdout() {}, stderr() {}, stdin: process.stdin, output: process.stdout, isTTY: false };
  try {
    assert.equal(await runCli(["shell", "test", "--", "tool", "--json", "--cwd", "/tmp"], io, { store, runtime: { async openSession(_profile, options) { openedCwd = options.cwd; return port; } } }), 0);
    assert.equal(received, "'tool' '--json' '--cwd' '/tmp'");
    assert.equal(openedCwd, "/workspace");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI shell preserves post-separator argument boundaries and metacharacters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-shell-argv-"));
  const store = new ProfileStore(path.join(root, "profiles.json"));
  await store.add({ name: "test", sshHost: "devbox", defaultCwd: "/workspace" });
  let received = "";
  const port = { async bash(command) { received = command; return { output: "ok" }; }, async close() {} };
  const io = { stdout() {}, stderr() {}, stdin: process.stdin, output: process.stdout, isTTY: false };
  try {
    assert.equal(await runCli(["shell", "test", "--", "cat", "file name", "$(touch /tmp/should-not-run)"], io, {
      store, runtime: { async openSession() { return port; } }
    }), 0);
    assert.equal(received, "'cat' 'file name' '$(touch /tmp/should-not-run)'");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime manager rejects a locally corrupted artifact before opening SSH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-corrupt-"));
  try {
    await writeFile(path.join(root, "corrupt.tar.gz"), "corrupt", "utf8");
    await writeFile(path.join(root, "artifact.json"), JSON.stringify({
      version: 1, platform: "linux", arch: "x64", libcMinimum: "2.27", runtimeVersion: "0.1.0", piVersion: "0.84.2",
      archive: "corrupt.tar.gz", archiveSha256: "0".repeat(64)
    }), "utf8");
    const profile = {
      id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "unreachable.invalid",
      network: { mode: "remote-direct", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
    };
    await assert.rejects(() => new ManagedRemoteRuntime({ artifactDirectory: root }).ensureRuntime(profile), (error) => error?.code === "runtime-artifact-hash-mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active full session IDs can reattach before metadata persistence when cwd is known", () => {
  const sessionId = "01a01b74-911b-7d4e-ad87-74dc0b6146fd";
  assert.deepEqual(resolveSessionForOpen([], sessionId, "/workspace"), { id: sessionId, cwd: "/workspace" });
  assert.throws(() => resolveSessionForOpen([], "01a01b74", "/workspace"), (error) => error?.code === "session-not-found");
  assert.throws(() => resolveSessionForOpen([], sessionId), (error) => error?.code === "session-not-found");
});

test("ensureRuntime atomically activates an already installed package artifact", async () => {
  const manager = new ManagedRemoteRuntime();
  const profile = {
    id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host",
    network: { mode: "remote-direct", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  const info = {
    controlVersion: 1, runtimeVersion: "0.1.0", piVersion: "0.84.2", nodeVersion: "bun", platform: "linux", arch: "x64",
    artifactSha256: "a".repeat(64), capabilities: [], remoteRoot: "/remote", profileRoot: "/profile", sessionRoot: "/sessions"
  };
  let activated = false;
  manager.readArtifact = async () => ({
    version: 1, platform: "linux", arch: "x64", libcMinimum: "2.27", runtimeVersion: "0.1.0", piVersion: "0.84.2",
    archive: "fixture.tar.gz", archiveSha256: "a".repeat(64), archivePath: "fixture.tar.gz"
  });
  manager.runtimeInfo = async () => info;
  manager.activateRuntime = async () => { activated = true; };
  assert.equal(await manager.ensureRuntime(profile), info);
  assert.equal(activated, true);
});

test("TUI setup closes egress when descriptor upload fails", async () => {
  let closed = false;
  const manager = new ManagedRemoteRuntime();
  manager.ensureRuntime = async () => ({ controlVersion: 1, runtimeVersion: "0.1.0", piVersion: "0.84.2", nodeVersion: "bun", platform: "linux", arch: "x64", artifactSha256: "a".repeat(64), capabilities: [], remoteRoot: "/r", profileRoot: "/p", sessionRoot: "/s" });
  manager.startEgress = async () => ({ mode: "client-proxy", proxyUrl: "http://pi:token@127.0.0.1:1", noProxy: [], remotePort: 1, token: "token", async close() { closed = true; } });
  manager.putDescriptor = async () => { throw new Error("fixture descriptor failure"); };
  const profile = { id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host", defaultCwd: "/work", network: { mode: "client-proxy", clientProxy: { noProxy: [], allowedPorts: [443] } }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  await assert.rejects(() => manager.openTui(profile), /fixture descriptor failure/u);
  assert.equal(closed, true);
});

test("file download waits for stdout to drain after the SSH child exits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-download-"));
  const target = path.join(root, "download.bin");
  const first = Buffer.alloc(256 * 1024, 0x41);
  const tail = Buffer.alloc(256 * 1024, 0x42);
  const fakeSsh = {
    spawn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.stdout.once("resume", () => {
        child.stdout.write(first);
        child.emit("exit", 0, null);
        setImmediate(() => child.stdout.end(tail));
        child.stderr.end();
      });
      return child;
    }
  };
  const manager = new ManagedRemoteRuntime({ ssh: fakeSsh });
  manager.ensureRuntime = async () => ({
    controlVersion: 1, runtimeVersion: "0.1.0", piVersion: "0.84.2", nodeVersion: "bun-compiled",
    platform: "linux", arch: "x64", artifactSha256: "a".repeat(64), capabilities: [],
    remoteRoot: "/remote", profileRoot: "/remote/profile", sessionRoot: "/remote/sessions"
  });
  const profile = {
    id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host",
    network: { mode: "remote-direct", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  try {
    await manager.getFile(profile, "/remote/file.bin", target, true);
    assert.deepEqual(await readFile(target), Buffer.concat([first, tail]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent no-clobber downloads use unique temporaries so exactly one publishes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-download-race-"));
  const target = path.join(root, "download.bin");
  let spawnIndex = 0;
  const fakeSsh = {
    spawn() {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => {};
      const payload = Buffer.from(`payload-${++spawnIndex}`);
      child.stdout.once("resume", () => setImmediate(() => {
        child.stdout.end(payload); child.stderr.end(); child.emit("exit", 0, null);
      }));
      return child;
    }
  };
  const manager = new ManagedRemoteRuntime({ ssh: fakeSsh });
  manager.ensureRuntime = async () => ({
    controlVersion: 1, runtimeVersion: "0.1.0", piVersion: "0.84.2", nodeVersion: "bun-compiled",
    platform: "linux", arch: "x64", artifactSha256: "a".repeat(64), capabilities: [],
    remoteRoot: "/remote", profileRoot: "/remote/profile", sessionRoot: "/remote/sessions"
  });
  const profile = {
    id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host",
    network: { mode: "remote-direct", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  try {
    const results = await Promise.allSettled([
      manager.getFile(profile, "/remote/a.bin", target, false),
      manager.getFile(profile, "/remote/b.bin", target, false)
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason?.code === "local-file-exists").length, 1);
    assert.match(await readFile(target, "utf8"), /^payload-[12]$/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("file upload turns a local read failure into a structured error and terminates SSH", async () => {
  const child = new EventEmitter();
  let killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {
    killed = true;
    child.stdout.end();
    child.stderr.end();
    child.stdin.destroy();
    child.emit("exit", 1, null);
  };
  const manager = new ManagedRemoteRuntime({ ssh: { spawn() { return child; } } });
  manager.ensureRuntime = async () => ({
    controlVersion: 1, runtimeVersion: "0.1.0", piVersion: "0.84.2", nodeVersion: "bun-compiled",
    platform: "linux", arch: "x64", artifactSha256: "a".repeat(64), capabilities: [],
    remoteRoot: "/remote", profileRoot: "/remote/profile", sessionRoot: "/remote/sessions"
  });
  const profile = {
    id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host",
    network: { mode: "remote-direct", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  await assert.rejects(() => manager.putFile(profile, path.join(os.tmpdir(), `missing-${Date.now()}`), "/remote/file.bin"), (error) => error?.code === "file-put-failed");
  assert.equal(killed, true);
});

test("runtime installer contains local archive read failures", async () => {
  const child = new EventEmitter();
  let killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {
    killed = true;
    child.stdout.end(); child.stderr.end(); child.stdin.destroy(); child.emit("exit", 1, null);
  };
  const manager = new ManagedRemoteRuntime({ ssh: { spawn() { return child; } } });
  const profile = {
    id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host",
    network: { mode: "remote-direct", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  await assert.rejects(() => manager.installArtifact(profile, {
    version: 1, platform: "linux", arch: "x64", libcMinimum: "2.27", runtimeVersion: "0.1.0", piVersion: "0.84.2",
    archive: "missing.tar.gz", archiveSha256: "a".repeat(64), archivePath: path.join(os.tmpdir(), `missing-runtime-${Date.now()}.tar.gz`)
  }), (error) => error?.code === "remote-install-failed");
  assert.equal(killed, true);
});

test("runtime installer drains an upload when a concurrent publisher wins the race", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-install-race-"));
  const archivePath = path.join(root, "runtime.tar.gz");
  await writeFile(archivePath, Buffer.alloc(2 * 1024 * 1024, 0x5a));
  let command = "";
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  const manager = new ManagedRemoteRuntime({ ssh: { spawn(_profile, value) {
    command = value;
    if (value.includes("cat >/dev/null")) {
      child.stdin.resume();
      child.stdin.once("end", () => setImmediate(() => {
        child.stdout.end("PI_REMOTE_INSTALL/1\tREUSED\n");
        child.stderr.end();
        child.emit("exit", 0, null);
      }));
    } else {
      setImmediate(() => child.stdin.destroy(Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
    }
    return child;
  } } });
  const profile = {
    id: "00000000-0000-4000-8000-000000000001", name: "fixture", sshHost: "host",
    network: { mode: "remote-direct", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  };
  try {
    await manager.installArtifact(profile, {
      version: 1, platform: "linux", arch: "x64", libcMinimum: "2.27", runtimeVersion: "0.1.0", piVersion: "0.84.2",
      archive: "runtime.tar.gz", archiveSha256: "a".repeat(64), archivePath
    });
    assert.match(command, /then cat >\/dev\/null;/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("published package carries a hash-verified offline runtime and thin extension", async () => {
  const packageRoot = process.cwd();
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@jasmine-ai/pi-remote");
  assert.equal(manifest.bin["pi-remote"], "./dist/cli.js");
  assert.deepEqual(manifest.pi.extensions, ["./dist/extension.js"]);
  assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], "0.84.2");
  assert.match(manifest.scripts["runtime:build:linux-x64"], /^npm run build && /u, "artifact builds must compile current sources first");
  const descriptorPath = path.join(packageRoot, "runtime", "linux-x64-glibc", "artifact.json");
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  assert.equal(descriptor.libcMinimum, "2.27");
  assert.equal(descriptor.piVersion, "0.84.2");
  const archivePath = path.join(path.dirname(descriptorPath), descriptor.archive);
  assert.equal(await sha256(archivePath), descriptor.archiveSha256);
  const builder = await readFile(path.join(packageRoot, "scripts", "build-runtime.mjs"), "utf8");
  assert.match(builder, /pi-remote-runtime-build-linux-x64/u, "compiled host output path must stay deterministic");
  assert.match(builder, /gzip -n/u, "gzip header timestamps must be disabled");
  assert.match(builder, /cp -L/u, "WSL binary copies must not pass through its truncation-prone stdout pipe");
  assert.match(builder, /readelf --version-info/u, "WSL runtime builds must inspect ELF symbol-version requirements");
  assert.match(builder, /assertGlibcBaseline/u, "runtime publication must enforce the declared glibc baseline");
  assert.match(builder, /apt-get -c \\"\$config\\"/u, "apt helper must explicitly load its secret temporary proxy config instead of trusting APT_CONFIG");
  const runtimeSource = await readFile(path.join(packageRoot, "runtime.ts"), "utf8");
  assert.ok(runtimeSource.includes('mv -T \\"$stage\\" \\"$runtime\\"'), "concurrent runtime publication must not nest staging directories");
  assert.ok(runtimeSource.includes('rm -rf \\"$stage\\"; fi'), "the losing concurrent installer must remove its staging directory");
  const reusedStart = runtimeSource.indexOf('if test -x \\\"$runtime/bin/pi-remote-host\\\"');
  const reusedExit = runtimeSource.indexOf("exit 0; fi", reusedStart);
  assert.ok(reusedStart >= 0 && runtimeSource.slice(reusedStart, reusedExit).includes('mv -Tf \\\"$link\\\" \\\"$root/current\\\"'),
    "a reused content-addressed runtime must still atomically become current after an upgrade rollback");
  const verifier = await readFile(path.join(packageRoot, "scripts", "verify-runtime.mjs"), "utf8");
  assert.match(verifier, /process\.stderr\.write/u, "prepack verification must not contaminate npm pack --json stdout");
  const extension = await readFile(path.join(packageRoot, "extension.ts"), "utf8");
  assert.match(extension, /registerCommand\("remote"/u);
  assert.match(extension, /registerCommand\("remote-doctor"/u);
  assert.doesNotMatch(extension, /registerTool|createReadTool|createWriteTool|createEditTool|createBashTool/u);
  const daemon = await readFile(path.join(packageRoot, "daemon.ts"), "utf8");
  assert.doesNotMatch(daemon, /socket\.setTimeout/u, "quiet RPC work must not be disconnected by a control-socket inactivity timeout");
  assert.match(daemon, /socket\.setKeepAlive/u);
  const host = await readFile(path.join(packageRoot, "host.ts"), "utf8");
  assert.match(host, /await pipeline\(createReadStream\(target\), process\.stdout, \{ end: false \}\)/u,
    "remote file download must drain its stdout pipeline before the host process exits");
  const stopStart = host.indexOf("async function stopCommand");
  const stopEnd = host.indexOf("async function egressLease", stopStart);
  const stopSource = host.slice(stopStart, stopEnd);
  const tuiLockIndex = stopSource.indexOf("`${sessionDescriptorPath}.lock`");
  const daemonLockIndex = stopSource.indexOf('"daemon-start.lock"');
  assert.ok(tuiLockIndex >= 0 && daemonLockIndex > tuiLockIndex,
    "stop must take the TUI startup lock before terminating either runtime mode");
  assert.doesNotMatch(host, /async function withFileLock/u, "host and profile operations must share the ownership-safe lock helper");
  const profiles = await readFile(path.join(packageRoot, "profiles.ts"), "utf8");
  assert.match(profiles, /withOwnedFileLock\(lockPath/u, "profile mutations must use the ownership-safe shared lock helper");
  const fileLock = await readFile(path.join(packageRoot, "file-lock.ts"), "utf8");
  assert.doesNotMatch(fileLock, /\.ino\b/u, "lock ownership must not depend on reusable inode numbers");
  assert.match(fileLock, /rename\(path\.join\(lockPath, ownerName\), tombstonePath\)/u, "lock release must atomically claim a unique owner filename");
  assert.match(fileLock, /claimed\.mtimeMs !== observedMtimeMs/u, "stale takeover must detect a heartbeat after its first observation");
  assert.match(fileLock, /rename\(tombstonePath, path\.join\(lockPath, ownerName\)\)/u, "a refreshed owner must be restored before takeover returns");
  assert.match(fileLock, /rmdir\(lockPath\)/u, "replacement lock directories must remain protected by their non-empty owner token");
});

test("package maintenance scripts are valid Node modules", async () => {
  const scriptsDir = path.join(process.cwd(), "scripts");
  for (const name of (await readdir(scriptsDir)).filter((entry) => entry.endsWith(".mjs")).sort()) {
    const result = spawnSync(process.execPath, ["--check", path.join(scriptsDir, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
