import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import chrome from "../../resources/builtin-plugins/chrome/index.js";

const tempDir = await mkdtemp(path.join(tmpdir(), "chrome-bridge-mode-"));
const bridgeFile = path.join(tempDir, "chrome-bridge.json");
const token = "chrome-bridge-mode-token";
const previousBridgeFile = process.env.JASMINE_CHROME_BRIDGE_FILE;
const previousTakeover = process.env.JASMINE_CHROME_TAKEOVER;
const requests = [];
const protocolErrors = [];
const sockets = new Set();
let screenshotPath;
let server;

try {
  server = createBridgeServer({ token, requests, protocolErrors, sockets });
  await listen(server);
  const port = server.address().port;
  await writeFile(bridgeFile, JSON.stringify({ port, token }));
  process.env.JASMINE_CHROME_BRIDGE_FILE = bridgeFile;
  process.env.JASMINE_CHROME_TAKEOVER = "1";

  const tools = collectTools();

  const status = await runTool(tools, "chrome_status", {});
  assert.match(textOf(status), /takeover bridge.*2 real Chrome tab\(s\)/);
  assert.equal(status.details.takeover, true);
  assert.equal(status.details.tabCount, 2);

  const tabs = await runTool(tools, "chrome_list_tabs", {});
  assert.match(textOf(tabs), /1\. A \(active\)/);
  assert.match(textOf(tabs), /id: 1/);
  assert.match(textOf(tabs), /url: http:\/\/a/);
  assert.deepEqual(tabs.details.tabs, [
    { id: "1", title: "A", url: "http://a", active: true }
  ]);

  const snapshot = await runTool(tools, "chrome_snapshot", { maxItems: 5 });
  assert.match(textOf(snapshot), /\[e1\] button "Go"/);
  assert.equal(snapshot.details.items.length, 1);

  const click = await runTool(tools, "chrome_click", { ref: "e1" });
  assert.match(textOf(click), /Clicked Chrome element: Go/);
  assert.equal(click.details.takeover, true);

  const type = await runTool(tools, "chrome_type", { ref: "e2", text: "hi", submit: true });
  assert.match(textOf(type), /Typed into Chrome element: Field/);
  assert.equal(type.details.submit, true);

  const navigated = await runTool(tools, "chrome_navigate", { url: "http://example.com/" });
  assert.match(textOf(navigated), /Navigated to http:\/\/example\.com\//);
  assert.equal(navigated.details.loaded, true);

  const screenshot = await runTool(tools, "chrome_screenshot", {});
  screenshotPath = screenshot.details.path;
  assert.match(textOf(screenshot), /Saved Chrome screenshot:/);
  assert.equal(screenshot.details.takeover, true);
  await access(screenshotPath);

  const evaluated = await runTool(tools, "chrome_evaluate", { expression: "1+1" });
  assert.equal(textOf(evaluated), "2");
  assert.equal(evaluated.details.value, 2);

  await assert.rejects(
    runTool(tools, "chrome_wait_for", { selector: "#never", timeoutMs: 200 }),
    /boom/
  );

  assert.deepEqual(requests, [
    { method: "status", params: {} },
    { method: "list_tabs", params: {} },
    { method: "snapshot", params: { maxItems: 5 } },
    { method: "click", params: { ref: "e1" } },
    { method: "type", params: { ref: "e2", text: "hi", submit: true } },
    { method: "navigate", params: { url: "http://example.com/" } },
    { method: "screenshot", params: {} },
    { method: "evaluate", params: { expression: "1+1" } },
    { method: "wait_for", params: { selector: "#never", timeoutMs: 200 } }
  ]);
  assert.deepEqual(protocolErrors, []);

  console.log("chrome-bridge-mode unit test passed");
} finally {
  for (const socket of sockets) socket.destroy();
  await closeServer(server);
  if (previousBridgeFile === undefined) delete process.env.JASMINE_CHROME_BRIDGE_FILE;
  else process.env.JASMINE_CHROME_BRIDGE_FILE = previousBridgeFile;
  if (previousTakeover === undefined) delete process.env.JASMINE_CHROME_TAKEOVER;
  else process.env.JASMINE_CHROME_TAKEOVER = previousTakeover;
  if (screenshotPath) await rm(screenshotPath, { force: true });
  await rm(tempDir, { recursive: true, force: true });
}

function createBridgeServer({ token: expectedToken, requests: received, protocolErrors: errors, sockets: activeSockets }) {
  return createServer((socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let greeted = false;

    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const message = JSON.parse(line);
            if (!greeted) {
              assert.deepEqual(message, {
                type: "hello",
                token: expectedToken,
                role: "agent"
              });
              greeted = true;
            } else {
              assert.equal(typeof message.id, "string");
              assert.match(message.id, /^[0-9a-f-]{36}$/);
              assert.equal(typeof message.method, "string");
              assert.equal(typeof message.params, "object");
              received.push({ method: message.method, params: message.params });
              const reply = extensionReply(message);
              socket.write(`${JSON.stringify({ id: message.id, ...reply })}\n`);
            }
          } catch (error) {
            errors.push(error);
            socket.destroy();
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
  });
}

function extensionReply(message) {
  switch (message.method) {
    case "status":
      return { ok: true, result: { connected: true, tabCount: 2 } };
    case "list_tabs":
      return {
        ok: true,
        result: {
          tabs: [{ id: "1", title: "A", url: "http://a", active: true }]
        }
      };
    case "snapshot":
      return {
        ok: true,
        result: {
          title: "Page",
          url: "http://a",
          items: [{ ref: "e1", tag: "button", name: "Go" }]
        }
      };
    case "click":
      return { ok: true, result: { tabId: "1", name: "Go", tag: "BUTTON" } };
    case "type":
      return { ok: true, result: { tabId: "1", name: "Field" } };
    case "navigate":
      return {
        ok: true,
        result: { url: "http://example.com/", title: "Example", loaded: true }
      };
    case "screenshot":
      return {
        ok: true,
        result: {
          tabId: "1",
          dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
        }
      };
    case "evaluate":
      return { ok: true, result: { value: 2 } };
    case "wait_for":
      return { ok: false, error: "boom" };
    default:
      return { ok: false, error: `Unexpected method: ${message.method}` };
  }
}

function collectTools() {
  const tools = new Map();
  chrome({
    registerTool(tool) {
      tools.set(tool.name, tool);
    }
  });
  return tools;
}

async function runTool(tools, name, params) {
  const tool = tools.get(name);
  assert.ok(tool, `Missing tool ${name}`);
  return tool.execute(`${name}-call`, params, new AbortController().signal);
}

function textOf(result) {
  return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      target.off("error", reject);
      resolve();
    });
  });
}

function closeServer(target) {
  if (!target) return Promise.resolve();
  return new Promise((resolve, reject) => {
    target.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
