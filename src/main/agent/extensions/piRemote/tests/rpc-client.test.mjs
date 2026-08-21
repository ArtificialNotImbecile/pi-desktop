import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DaemonClient, JsonFrameDecoder, PiRpcSessionPort, encodeJsonFrame, resolveSessionMetadata } from "../dist/index.js";

test("daemon client correlates framed requests and replays sequenced events over any ordered byte transport", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const decoder = new JsonFrameDecoder();
  const runtimeInfo = {
    controlVersion: 1,
    runtimeVersion: "0.1.1",
    piVersion: "0.84.2",
    nodeVersion: "bun-compiled",
    platform: "linux",
    arch: "x64",
    artifactSha256: "a".repeat(64),
    capabilities: ["rpc-jsonl"],
    remoteRoot: "/remote",
    profileRoot: "/remote/profile",
    sessionRoot: "/remote/sessions"
  };
  clientToServer.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.type === "hello") {
        fragmentedWrite(serverToClient, encodeJsonFrame({ type: "hello_ok", info: runtimeInfo, seq: 4 }));
        fragmentedWrite(serverToClient, encodeJsonFrame({ type: "event", event: { seq: 5, type: "replayed", data: { detached: true } } }));
      } else if (message.type === "request") {
        fragmentedWrite(serverToClient, encodeJsonFrame({ type: "response", id: message.id, ok: true, result: { method: message.method } }));
      }
    }
  });
  const client = new DaemonClient({ readable: serverToClient, writable: clientToServer, close() { serverToClient.end(); clientToServer.end(); } });
  assert.deepEqual(await client.connect(), runtimeInfo);
  assert.deepEqual(await client.request("runtime.info"), { method: "runtime.info" });
  const events = [];
  client.subscribe((event) => events.push(event));
  fragmentedWrite(serverToClient, encodeJsonFrame({ type: "event", event: { seq: 6, type: "fixture", data: { ok: true } } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    { seq: 5, type: "replayed", data: { detached: true } },
    { seq: 6, type: "fixture", data: { ok: true } }
  ]);
  client.close();
});

test("daemon client rejects connect when the transport closes before hello", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const client = new DaemonClient({ readable: serverToClient, writable: clientToServer, close() { serverToClient.destroy(); clientToServer.destroy(); } });
  const connecting = client.connect();
  serverToClient.destroy();
  await assert.rejects(
    Promise.race([
      connecting,
      new Promise((_, reject) => setTimeout(() => reject(new Error("connect did not settle after transport close")), 500))
    ]),
    (error) => error?.code === "daemon-disconnected"
  );
  await assert.rejects(() => client.request("after-close"), (error) => error?.code === "daemon-disconnected");
  client.close();
});

test("daemon client turns writable transport errors into structured disconnects", async () => {
  const writable = new PassThrough();
  const readable = new PassThrough();
  const client = new DaemonClient({ readable, writable, close() { readable.destroy(); writable.destroy(); } });
  const connecting = client.connect();
  writable.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  await assert.rejects(connecting, (error) => error?.code === "daemon-disconnected" && error.retryable === true);
  await assert.rejects(() => client.request("after-writable-error"), (error) => error?.code === "daemon-disconnected");
  client.close();
});

test("daemon client converts malformed hello frames into a structured disconnect and closes transport", async () => {
  const writable = new PassThrough();
  const readable = new PassThrough();
  let closed = false;
  const client = new DaemonClient({ readable, writable, close() { closed = true; readable.destroy(); writable.destroy(); } });
  const connecting = client.connect();
  readable.write(Buffer.from([0, 0, 0, 1, 0x7b]));
  await assert.rejects(connecting, (error) => error?.code === "daemon-disconnected" && error.retryable === true);
  assert.equal(closed, true);
});

test("daemon client rejects pending requests and closes transport on an oversized frame", async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const decoder = new JsonFrameDecoder();
  let closed = false;
  clientToServer.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.type === "hello") {
        serverToClient.write(encodeJsonFrame({
          type: "hello_ok",
          seq: 0,
          info: {
            controlVersion: 1, runtimeVersion: "0.1.1", piVersion: "0.84.2", nodeVersion: "bun-compiled",
            platform: "linux", arch: "x64", artifactSha256: "a".repeat(64), capabilities: [],
            remoteRoot: "/remote", profileRoot: "/remote/profile", sessionRoot: "/remote/sessions"
          }
        }));
      }
    }
  });
  const client = new DaemonClient({ readable: serverToClient, writable: clientToServer, close() { closed = true; serverToClient.destroy(); clientToServer.destroy(); } });
  await client.connect();
  const pending = client.request("runtime.info");
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(64 * 1024 * 1024);
  serverToClient.write(oversized);
  await assert.rejects(pending, (error) => error?.code === "daemon-disconnected" && error.retryable === true);
  assert.equal(closed, true);
});

test("session prefixes must resolve uniquely and exact IDs always win", () => {
  const sessions = [{ id: "session-alpha" }, { id: "session-alpine" }, { id: "other" }];
  assert.equal(resolveSessionMetadata(sessions, "session-alpha").id, "session-alpha");
  assert.equal(resolveSessionMetadata(sessions, "oth").id, "other");
  assert.throws(() => resolveSessionMetadata(sessions, "session-al"), (error) => error?.code === "session-id-ambiguous");
  assert.throws(() => resolveSessionMetadata(sessions, "missing"), (error) => error?.code === "session-not-found");
});

test("Pi RPC port keeps the upstream wire private and resolves inner command responses", async () => {
  const requests = [];
  const listeners = new Set();
  const disconnectListeners = new Set();
  const fakeClient = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeDisconnect(listener) { disconnectListeners.add(listener); return () => disconnectListeners.delete(listener); },
    async request(method, params) {
      requests.push({ method, params });
      if (method === "sessions.list") return [];
      if (method === "rpc.send") {
        const command = params.command;
        queueMicrotask(() => {
          for (const listener of listeners) listener({
            seq: requests.length,
            type: "rpc.message",
            data: { type: "response", id: command.id, command: command.type, success: true, data: { accepted: command.type } }
          });
        });
        return { accepted: true };
      }
      return {};
    },
    close() {}
  };
  const port = new PiRpcSessionPort(fakeClient, ["rpc-jsonl", "prompt-image"]);
  assert.deepEqual(await port.bash("pwd"), { accepted: "bash" });
  assert.deepEqual(await port.compact("focus"), { accepted: "compact" });
  assert.equal(requests.filter((entry) => entry.method === "rpc.send").length, 2);
  assert.equal(port.capabilities.includes("prompt-image"), true);

  fakeClient.request = async (method, params) => {
    if (method === "rpc.send") {
      queueMicrotask(() => { for (const listener of listeners) listener({ seq: 99, type: "rpc.exit", data: { code: 1 } }); });
      return { accepted: true };
    }
    return {};
  };
  await assert.rejects(() => port.getTree(), (error) => error?.code === "remote-process-exited");
});

test("Pi RPC session replacements retain their client-proxy launch descriptor", async () => {
  const requests = [];
  const listeners = new Set();
  const fakeClient = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeDisconnect() { return () => {}; },
    async request(method, params) {
      requests.push({ method, params });
      if (method === "sessions.list") return [{ id: "session-old", cwd: "/old" }];
      if (method === "rpc.send") {
        const command = params.command;
        queueMicrotask(() => {
          const data = command.type === "get_state" ? { sessionId: "session-new" } : {};
          for (const listener of listeners) listener({ seq: requests.length, type: "rpc.message", data: { type: "response", id: command.id, success: true, data } });
        });
      }
      return {};
    },
    close() {}
  };
  const proxy = { url: "http://pi:token@127.0.0.1:50000", noProxy: ["localhost"] };
  const port = new PiRpcSessionPort(fakeClient, ["rpc-jsonl", "client-proxy"], proxy);
  await port.openSession("session-old");
  await port.createSession("/new");
  const starts = requests.filter((entry) => entry.method === "rpc.start");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[0].params.proxy, proxy);
  assert.deepEqual(starts[1].params.proxy, proxy);
});

test("Pi RPC port rejects inner commands when the daemon transport disconnects", async () => {
  const disconnectListeners = new Set();
  const fakeClient = {
    subscribe() { return () => {}; },
    subscribeDisconnect(listener) { disconnectListeners.add(listener); return () => disconnectListeners.delete(listener); },
    async request() { return { accepted: true }; },
    close() {}
  };
  const port = new PiRpcSessionPort(fakeClient, ["rpc-jsonl"]);
  const events = [];
  port.subscribe((event) => events.push(event));
  const pending = port.bash("sleep 180");
  await new Promise((resolve) => setImmediate(resolve));
  for (const listener of disconnectListeners) listener(new Error("fixture disconnect"));
  await assert.rejects(pending, (error) => error?.code === "daemon-disconnected" && error.retryable === true);
  assert.equal(events.at(-1)?.type, "transport.disconnected");
});

test("Pi RPC port consumes its inner result when control send disconnects", async () => {
  const disconnectListeners = new Set(); let unhandled;
  const onUnhandled = (error) => { unhandled = error; };
  process.on("unhandledRejection", onUnhandled);
  const fakeClient = {
    subscribe() { return () => {}; },
    subscribeDisconnect(listener) { disconnectListeners.add(listener); return () => disconnectListeners.delete(listener); },
    async request() { for (const listener of disconnectListeners) listener(new Error("fixture")); throw new Error("send failed"); },
    close() {}
  };
  const port = new PiRpcSessionPort(fakeClient, ["rpc-jsonl"]);
  try {
    await assert.rejects(() => port.bash("large command"), /send failed/u);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

test("Pi RPC port returns when control send was already disconnected", async () => {
  const fakeClient = {
    subscribe() { return () => {}; }, subscribeDisconnect() { return () => {}; },
    async request() { const error = new Error("already disconnected"); error.code = "daemon-disconnected"; throw error; }, close() {}
  };
  const port = new PiRpcSessionPort(fakeClient, ["rpc-jsonl"]);
  await assert.rejects(() => port.bash("pwd"), (error) => error?.code === "daemon-disconnected");
});

test("Pi RPC port preserves replay until its public subscriber attaches", () => {
  const replay = { seq: 7, type: "rpc.message", data: { type: "agent_end" } };
  const fakeClient = {
    subscribe(listener) { listener(replay); return () => {}; },
    subscribeDisconnect() { return () => {}; },
    close() {}
  };
  const port = new PiRpcSessionPort(fakeClient, ["rpc-jsonl"]);
  const events = [];
  port.subscribe((event) => events.push(event));
  assert.deepEqual(events, [replay]);
});

test("Pi RPC detach drops only the client transport while close requests a remote stop", async () => {
  const calls = [];
  const fakeClient = {
    subscribe() { return () => { calls.push("unsubscribe"); }; },
    subscribeDisconnect() { return () => { calls.push("unsubscribe-disconnect"); }; },
    async request(method, params) { calls.push([method, params]); return {}; },
    close() { calls.push("client-close"); }
  };
  const detached = new PiRpcSessionPort(fakeClient, ["rpc-jsonl"]);
  await detached.detach();
  assert.deepEqual(calls, ["unsubscribe", "unsubscribe-disconnect", "client-close"],
    "detach must not send rpc.stop");

  calls.length = 0;
  const closed = new PiRpcSessionPort(fakeClient, ["rpc-jsonl"]);
  await closed.close({ abort: false });
  assert.deepEqual(calls, [
    ["rpc.stop", { abort: false }],
    "unsubscribe",
    "unsubscribe-disconnect",
    "client-close"
  ]);
});

function fragmentedWrite(stream, frame) {
  const buffer = Buffer.from(frame);
  for (let index = 0; index < buffer.length; index += 3) stream.write(buffer.subarray(index, index + 3));
}
