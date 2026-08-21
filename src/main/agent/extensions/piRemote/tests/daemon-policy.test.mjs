import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { RemoteHostDaemon, acquireSessionMode, daemonStatus, releaseSessionMode, rpcLaunchMatches, waitForRpcDrain, writeRpcInput } from "../dist/daemon.js";
import { withOwnedFileLock } from "../dist/file-lock.js";
import { encodeJsonFrame, JsonFrameDecoder } from "../dist/framing.js";

test("RPC reuse is scoped to both cwd and the bound session", () => {
  const current = { cwd: "/workspace", sessionId: "session-a" };
  assert.equal(rpcLaunchMatches(current, { cwd: "/workspace", sessionId: "session-a" }), true);
  assert.equal(rpcLaunchMatches(current, { cwd: "/workspace", sessionId: "session-b" }), false);
  assert.equal(rpcLaunchMatches(current, { cwd: "/other", sessionId: "session-a" }), false);
  assert.equal(rpcLaunchMatches({ cwd: "/workspace" }, { cwd: "/workspace" }), true);
});

test("TUI and RPC launches share one profile-scoped mode lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-mode-"));
  const paths = { profileRoot: root };
  try {
    await acquireSessionMode(paths, "tui", "tui-run");
    await assert.rejects(() => acquireSessionMode(paths, "rpc", "rpc-run"), (error) => error?.code === "session-mode-conflict");
    await releaseSessionMode(paths, "tui-run");
    await writeFile(path.join(root, "session-mode.json"), JSON.stringify({ version: 1, mode: "tui", runId: "stale", pid: 2147483647, processIdentity: "stale" }));
    const staleGuard = path.join(root, "session-mode.json.acquire.lock");
    await mkdir(staleGuard);
    const staleOwner = path.join(staleGuard, "owner-00000000-0000-4000-8000-000000000004.lock");
    await writeFile(staleOwner, "stale");
    await utimes(staleOwner, new Date(0), new Date(0));
    const contenders = await Promise.allSettled([
      acquireSessionMode(paths, "rpc", "rpc-run"),
      acquireSessionMode(paths, "tui", "tui-run-2")
    ]);
    assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(contenders.filter((result) => result.status === "rejected" && result.reason?.code === "session-mode-conflict").length, 1);
    await releaseSessionMode(paths, contenders[0].status === "fulfilled" ? "rpc-run" : "tui-run-2");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daemon status rejects a live PID whose process identity does not match", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-status-"));
  const paths = { statusPath: path.join(root, "status.json"), socketPath: path.join(root, "daemon.sock") };
  try {
    await mkdir(root, { recursive: true });
    await writeFile(paths.statusPath, JSON.stringify({ pid: process.pid, processIdentity: "not-this-process", runtimeVersion: "0.1.1" }));
    assert.deepEqual(await daemonStatus(paths), { running: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("backpressured RPC writes reject when the child closes before drain", async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough();
  const pending = waitForRpcDrain(child);
  child.emit("close", 1, null);
  await assert.rejects(pending, (error) => error?.code === "rpc-process-closed");
});

test("RPC input rejects an asynchronous writable EPIPE after write returned true", async () => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = (_input, callback) => {
    setImmediate(() => {
      const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      child.stdin.emit("error", error);
      callback?.(error);
    });
    return true;
  };
  await assert.rejects(writeRpcInput(child, "{}\n"), (error) => error?.code === "rpc-process-error" && error.retryable === true);
});

test("daemon isolates a structurally invalid control client without an unhandled rejection", async () => {
  const paths = { remoteRoot: "/remote", profileRoot: "/remote/profile", sessionDir: "/remote/sessions" };
  const daemon = new RemoteHostDaemon({ profileId: "00000000-0000-4000-8000-000000000001", paths, artifactSha256: "a".repeat(64) });
  let unhandled;
  const onUnhandled = (error) => { unhandled = error; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const invalid = fakeSocket();
    daemon.accept(invalid);
    invalid.emit("data", encodeJsonFrame(null));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(invalid.destroyedByDaemon, true);
    assert.equal(unhandled, undefined);

    const valid = fakeSocket();
    daemon.accept(valid);
    valid.emit("data", encodeJsonFrame({ type: "hello", version: 1, clientId: "fixture-client", afterSeq: 0 }));
    await new Promise((resolve) => setImmediate(resolve));
    const decoder = new JsonFrameDecoder();
    const responses = valid.writes.flatMap((chunk) => decoder.push(chunk));
    assert.equal(responses.some((message) => message.type === "hello_ok"), true, "a later valid client must still reach the shared daemon");
    assert.equal(valid.destroyedByDaemon, false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("daemon cancels RPC startup and releases its mode lease when the requesting client disconnects during lock wait", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-startup-disconnect-"));
  const profileRoot = path.join(root, "profile");
  const paths = {
    remoteRoot: root,
    runtimeRoot: path.join(root, "runtime"),
    profileRoot,
    agentDir: path.join(profileRoot, "agent"),
    sessionDir: path.join(profileRoot, "sessions"),
    piExecutable: path.join(root, "must-not-spawn")
  };
  const guardPath = `${path.join(profileRoot, "session-mode.json")}.acquire.lock`;
  let releaseGuard;
  let markHeld;
  const held = new Promise((resolve) => { markHeld = resolve; });
  const blocked = new Promise((resolve) => { releaseGuard = resolve; });
  const blocker = withOwnedFileLock(guardPath, async () => { markHeld(); await blocked; });
  await held;
  const daemon = new RemoteHostDaemon({ profileId: "00000000-0000-4000-8000-000000000001", paths, artifactSha256: "a".repeat(64) });
  const socket = fakeSocket();
  const startup = daemon.startRpc({ cwd: "/" }, socket);
  await new Promise((resolve) => setImmediate(resolve));
  socket.destroy();
  releaseGuard();
  await blocker;
  try {
    await assert.rejects(startup, (error) => error?.code === "daemon-disconnected" && error.retryable === true);
    await assert.rejects(readFile(path.join(profileRoot, "session-mode.json")), (error) => error?.code === "ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daemon clears speculative busy after rejected prompt, steer, and follow-up commands", async () => {
  const daemon = new RemoteHostDaemon({ profileId: "00000000-0000-4000-8000-000000000001", paths: {}, artifactSha256: "a".repeat(64) });
  const socket = fakeSocket();
  const processFixture = new EventEmitter();
  processFixture.stdin = new EventEmitter();
  processFixture.stdin.write = (_line, callback) => { callback?.(); return true; };
  const state = {
    process: processFixture,
    owner: socket,
    cwd: "/workspace",
    busy: false,
    agentActive: false,
    pendingTurnCommandIds: new Set(),
    stdoutBuffer: "",
    stderrTail: ""
  };
  daemon.rpc = state;
  for (const type of ["prompt", "steer", "follow_up"]) {
    const id = `${type}-id`;
    await daemon.sendRpc({ command: { id, type, message: "fixture" } }, socket);
    assert.equal(state.busy, true, `${type} is speculatively busy before Pi responds`);
    daemon.receiveRpcStdout(`${JSON.stringify({ type: "response", id, command: type, success: false, error: "rejected" })}\n`);
    assert.equal(state.busy, false, `${type} rejection clears speculative busy`);
    assert.equal(state.pendingTurnCommandIds.size, 0);
  }

  state.agentActive = true;
  state.busy = true;
  await daemon.sendRpc({ command: { id: "active-steer", type: "steer", message: "fixture" } }, socket);
  daemon.receiveRpcStdout(`${JSON.stringify({ type: "response", id: "active-steer", command: "steer", success: false })}\n`);
  assert.equal(state.busy, true, "a rejected steer cannot clear an already active agent turn");
});

test("daemon rolls back speculative busy when prompt, steer, and follow-up writes fail", async () => {
  const daemon = new RemoteHostDaemon({ profileId: "00000000-0000-4000-8000-000000000001", paths: {}, artifactSha256: "a".repeat(64) });
  const socket = fakeSocket();
  for (const type of ["prompt", "steer", "follow_up"]) {
    const processFixture = new EventEmitter();
    processFixture.stdin = new EventEmitter();
    processFixture.stdin.write = (_line, callback) => {
      setImmediate(() => {
        const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
        processFixture.stdin.emit("error", error);
        callback?.(error);
      });
      return true;
    };
    const state = {
      process: processFixture, owner: socket, cwd: "/workspace", busy: false, agentActive: false,
      pendingTurnCommandIds: new Set(), stdoutBuffer: "", stderrTail: ""
    };
    daemon.rpc = state;
    await assert.rejects(daemon.sendRpc({ command: { id: `${type}-write`, type, message: "fixture" } }, socket),
      (error) => error?.code === "rpc-process-error");
    assert.equal(state.busy, false, `${type} write rejection clears speculative busy`);
    assert.equal(state.pendingTurnCommandIds.size, 0);
  }

  const knownErrorState = {
    process: new EventEmitter(), owner: socket, cwd: "/workspace", busy: false, agentActive: false,
    pendingTurnCommandIds: new Set(), stdoutBuffer: "", stderrTail: "", stdinError: new Error("stdin already failed")
  };
  knownErrorState.process.stdin = new EventEmitter();
  knownErrorState.process.stdin.write = () => { throw new Error("must not write after recorded stdin failure"); };
  daemon.rpc = knownErrorState;
  await assert.rejects(daemon.sendRpc({ command: { id: "known-error", type: "prompt", message: "fixture" } }, socket),
    (error) => error?.code === "rpc-process-error");
  assert.equal(knownErrorState.busy, false);
  assert.equal(knownErrorState.pendingTurnCommandIds.size, 0);
});

function fakeSocket() {
  const socket = new EventEmitter();
  socket.writes = [];
  socket.destroyedByDaemon = false;
  socket.destroyed = false;
  socket.setKeepAlive = () => {};
  socket.write = (chunk) => { socket.writes.push(Buffer.from(chunk)); return true; };
  socket.end = () => socket.emit("close");
  socket.destroy = () => { socket.destroyed = true; socket.destroyedByDaemon = true; socket.emit("close"); };
  return socket;
}

test("rpc.start rejects a missing remote working directory with a clear error before spawning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-cwd-missing-"));
  const profileRoot = path.join(root, "profile");
  const paths = {
    remoteRoot: root,
    runtimeRoot: path.join(root, "runtime"),
    profileRoot,
    agentDir: path.join(profileRoot, "agent"),
    sessionDir: path.join(profileRoot, "sessions"),
    piExecutable: path.join(root, "must-not-spawn")
  };
  try {
    const daemon = new RemoteHostDaemon({ profileId: "00000000-0000-4000-8000-000000000001", paths, artifactSha256: "a".repeat(64) });
    const socket = fakeSocket();
    // Regression: a nonexistent cwd previously surfaced as an opaque spawn ENOENT
    // ("Remote Pi RPC process exited") only after the process launched and failed.
    await assert.rejects(daemon.startRpc({ cwd: "/nonexistent-pi-remote-cwd-fixture" }, socket), (error) => {
      return error?.code === "cwd-missing" && /does not exist/u.test(error.message) && Boolean(error.remediation);
    });
    assert.equal(daemon.rpc, undefined, "no RPC process was started for a missing cwd");
    await assert.rejects(readFile(path.join(profileRoot, "session-mode.json")), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
