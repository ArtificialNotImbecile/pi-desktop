import assert from "node:assert/strict";
import { connect } from "node:net";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeMessage, MessageParser } from "../../resources/chrome-extension/native-host/framing.mjs";

const tempDir = await mkdtemp(path.join(tmpdir(), "chrome-bridge-"));
const bridgeFile = path.join(tempDir, "chrome-bridge.json");
const previousBridgeFile = process.env.JASMINE_CHROME_BRIDGE_FILE;
const previousTakeover = process.env.JASMINE_CHROME_TAKEOVER;
const previousSkipExternalRegistration = process.env.JASMINE_CHROME_SKIP_EXTERNAL_REGISTRATION;
process.env.JASMINE_CHROME_BRIDGE_FILE = bridgeFile;
process.env.JASMINE_CHROME_SKIP_EXTERNAL_REGISTRATION = "1";

let bridge;
let extension;
let agent;
try {
  // 1. Native messaging framing round-trips, including split chunks.
  {
    const collected = [];
    const parser = new MessageParser((message) => collected.push(message));
    const framed = encodeMessage({ hello: "world", n: 7 });
    parser.push(framed.subarray(0, 3));
    parser.push(framed.subarray(3));
    assert.deepEqual(collected, [{ hello: "world", n: 7 }]);

    const twoParser = new MessageParser();
    const two = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 2 })]);
    assert.deepEqual(twoParser.push(two), [{ a: 1 }, { b: 2 }]);
  }

  const {
    ChromeBridge,
    buildNativeHostManifest,
    launcherScriptFor,
    windowsRegistryTargets,
    BUNDLED_CHROME_EXTENSION_ID,
    NATIVE_HOST_NAME
  } = await import("../../dist/main/main/services/chromeBridge.js");

  // 2. Manifest + launcher generation are well formed.
  {
    const manifest = buildNativeHostManifest("a".repeat(32), "C:/launcher.cmd");
    assert.equal(manifest.name, NATIVE_HOST_NAME);
    assert.equal(manifest.type, "stdio");
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${"a".repeat(32)}/`]);

    const launcher = launcherScriptFor("/path/to/electron", "/path/to/host.mjs");
    assert.match(launcher.contents, /ELECTRON_RUN_AS_NODE=1/);
    assert.match(launcher.contents, /host\.mjs/);
    assert.ok(windowsRegistryTargets().every((key) => key.includes(NATIVE_HOST_NAME)));
  }

  // 3. Agent <-> extension request routing through the bridge.
  {
    bridge = new ChromeBridge(tempDir);
    const status = await bridge.start();
    assert.equal(status.bridgeRunning, true);
    const info = JSON.parse(await readFile(bridgeFile, "utf8"));
    assert.equal(typeof info.port, "number");
    assert.equal(typeof info.token, "string");

    extension = await connectClient(info.port);
    let replyToExtension = true;
    extension.onMessage((message) => {
      if (replyToExtension && typeof message.id === "number") {
        assert.equal(message.__bridgeId, undefined);
        extension.send({ id: message.id, ok: true, result: fakeExtensionResult(message) });
      }
    });
    extension.send({ type: "hello", token: info.token, role: "chrome-extension" });

    await waitFor(() => bridge.status().extensionConnected && bridge.status().extensionResponsive);

    agent = await connectClient(info.port);
    agent.send({ type: "hello", token: info.token, role: "agent" });

    const replyPromise = new Promise((resolve) => agent.onMessage(resolve));
    agent.send({ id: "req-1", method: "snapshot", params: { maxItems: 5 } });
    const reply = await withTimeout(replyPromise, 1000, "Real extension reply was not routed back to the agent.");
    assert.equal(reply.id, "req-1");
    assert.equal(reply.ok, true);
    assert.equal(reply.result.method, "snapshot");
    assert.equal(reply.result.items.length, 1);
    assert.equal(reply.__bridgeId, undefined);

    replyToExtension = false;
    const degraded = await bridge.refreshExtensionHealth(50);
    assert.equal(degraded.extensionConnected, true);
    assert.equal(degraded.extensionResponsive, false);

    extension.close();
    extension = null;
    agent.close();
    agent = null;
  }

  // 4. A bad auth token is rejected.
  {
    const info = JSON.parse(await readFile(bridgeFile, "utf8"));
    const rogue = await connectClient(info.port);
    const closed = new Promise((resolve) => rogue.onClose(resolve));
    rogue.send({ type: "hello", token: "wrong", role: "agent" });
    await closed;
  }

  // 5. Registration can be disabled idempotently, and cleanup removes bridge credentials.
  {
    const registered = await bridge.registerNativeHost();
    assert.equal(registered.hostRegistered, true);
    assert.equal(registered.extensionId, BUNDLED_CHROME_EXTENSION_ID);

    const unregistered = await bridge.unregisterNativeHost();
    assert.equal(unregistered.hostRegistered, false);
    assert.equal(unregistered.extensionId, BUNDLED_CHROME_EXTENSION_ID);
    assert.equal((await bridge.unregisterNativeHost()).hostRegistered, false);

    await bridge.cleanup();
    assert.equal(bridge.status().bridgeRunning, false);
    await assert.rejects(access(bridgeFile));
  }

  console.log("chrome-bridge unit test passed");
} finally {
  extension?.close?.();
  agent?.close?.();
  await bridge?.stop?.();
  if (previousBridgeFile === undefined) delete process.env.JASMINE_CHROME_BRIDGE_FILE;
  else process.env.JASMINE_CHROME_BRIDGE_FILE = previousBridgeFile;
  if (previousTakeover === undefined) delete process.env.JASMINE_CHROME_TAKEOVER;
  else process.env.JASMINE_CHROME_TAKEOVER = previousTakeover;
  if (previousSkipExternalRegistration === undefined) delete process.env.JASMINE_CHROME_SKIP_EXTERNAL_REGISTRATION;
  else process.env.JASMINE_CHROME_SKIP_EXTERNAL_REGISTRATION = previousSkipExternalRegistration;
  await rm(tempDir, { recursive: true, force: true });
}

function fakeExtensionResult(message) {
  const params = message.params ?? {};
  const base = { method: message.method, tabId: "101", title: "Real Chrome tab", url: "https://example.test/" };
  if (message.method === "status") return { ...base, connected: true, tabCount: 1 };
  if (message.method === "list_tabs") return { ...base, tabs: [{ id: "101", title: "Real Chrome tab", url: "https://example.test/", active: true }] };
  if (message.method === "new_tab") return { ...base, id: "102", url: params.url ?? "about:blank", active: true };
  if (message.method === "snapshot") {
    return {
      ...base,
      count: 1,
      items: [{ ref: "e1", tag: "input", role: "input", type: "text", name: "Search", value: "", href: "", disabled: false }]
    };
  }
  if (message.method === "read_page") return { ...base, text: "Real page text", truncated: false };
  if (message.method === "navigate") return { ...base, loaded: true, url: params.url ?? "https://example.test/reloaded" };
  if (message.method === "evaluate") return { ...base, value: "bridge value" };
  if (message.method === "screenshot") {
    return {
      ...base,
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
    };
  }
  return {
    ...base,
    ...params,
    ok: true,
    tag: "INPUT",
    name: "Search",
    x: 10,
    y: 10
  };
}

function connectClient(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      let buffer = "";
      let messageHandler = null;
      let closeHandler = null;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line && messageHandler) messageHandler(JSON.parse(line));
          index = buffer.indexOf("\n");
        }
      });
      socket.on("close", () => closeHandler?.());
      resolve({
        send: (value) => socket.write(`${JSON.stringify(value)}\n`),
        onMessage: (handler) => { messageHandler = handler; },
        onClose: (handler) => { closeHandler = handler; },
        close: () => socket.destroy()
      });
    });
    socket.once("error", reject);
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition not met within timeout.");
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
