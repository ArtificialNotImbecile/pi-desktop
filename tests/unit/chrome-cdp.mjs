import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import chrome, { shutdownLaunchedChrome } from "../../resources/builtin-plugins/chrome/index.js";

const tempDir = await mkdtemp(path.join(tmpdir(), "chrome-cdp-"));
let httpServer;
const previousEndpoint = process.env.CHROME_CDP_URL;
const previousHeadless = process.env.CHROME_HEADLESS;
const previousUserDataDir = process.env.CHROME_USER_DATA_DIR;

try {
  httpServer = createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404).end("missing");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Chrome CDP fixture</title></head>
        <body>
          <main>
            <h1>Chrome CDP fixture</h1>
            <label>Name <input id="name" aria-label="Name" /></label>
            <button id="apply">Apply</button>
            <p id="result">Waiting</p>
            <select id="color" aria-label="Color">
              <option value="r">Red</option>
              <option value="g">Green</option>
            </select>
            <p id="color-result">none</p>
            <button id="delay">Delay</button>
            <p id="later"></p>
          </main>
          <script>
            document.querySelector("#apply").addEventListener("click", () => {
              document.querySelector("#result").textContent = "Hello " + document.querySelector("#name").value;
            });
            document.querySelector("#color").addEventListener("change", (event) => {
              document.querySelector("#color-result").textContent = event.target.value;
            });
            document.querySelector("#delay").addEventListener("click", () => {
              setTimeout(() => {
                document.querySelector("#later").textContent = "ready";
              }, 250);
            });
          </script>
        </body>
      </html>`);
  });
  await listen(httpServer);
  const httpPort = httpServer.address().port;
  delete process.env.CHROME_CDP_URL;
  process.env.CHROME_HEADLESS = "1";
  process.env.CHROME_USER_DATA_DIR = path.join(tempDir, "profile");

  const tools = collectTools();
  const unavailableEndpoint = await closedLocalEndpoint();
  process.env.CHROME_CDP_URL = unavailableEndpoint;
  const firstOpenPath = path.join(tempDir, "first-open.html");
  await writeFile(firstOpenPath, "<!doctype html><title>First open readiness</title>");
  const openPathError = await rejectsWithMessage(() => runTool(tools, "chrome_open_path", { path: firstOpenPath }));
  assert.match(openPathError, /Chrome DevTools endpoint is not ready/);
  assert.equal(openPathError.includes(unavailableEndpoint), true);
  assert.notEqual(openPathError.trim(), "fetch failed");
  const openUrlError = await rejectsWithMessage(() => runTool(tools, "chrome_open_url", {
    url: `http://127.0.0.1:${httpPort}/`
  }));
  assert.match(openUrlError, /Chrome DevTools endpoint is not ready/);
  assert.equal(openUrlError.includes(unavailableEndpoint), true);
  assert.notEqual(openUrlError.trim(), "fetch failed");
  delete process.env.CHROME_CDP_URL;

  const browserExecutable = await resolveBrowserExecutable();
  if (!browserExecutable) {
    console.warn("Skipping Chrome CDP smoke: no Chrome, Chromium, or Edge executable was found.");
  } else {
    for (const name of [
      "chrome_open_url", "chrome_open_path", "chrome_type", "chrome_screenshot",
      "chrome_snapshot", "chrome_click", "chrome_press_key", "chrome_scroll",
      "chrome_hover", "chrome_select_option", "chrome_wait_for", "chrome_navigate",
      "chrome_new_tab", "chrome_close_tab", "chrome_activate_tab", "chrome_evaluate"
    ]) {
      assert.equal(tools.has(name), true, `Missing tool ${name}`);
    }

    const status = await runTool(tools, "chrome_status", {});
    assert.match(textOf(status), /Connected to Chrome DevTools/);

    const pageUrl = `http://127.0.0.1:${httpPort}/`;
    const tabSelector = { urlContains: `127.0.0.1:${httpPort}` };
    await runTool(tools, "chrome_open_url", { url: pageUrl });
    const readPage = await eventually(async () => {
      const result = await runTool(tools, "chrome_read_page", tabSelector);
      assert.match(textOf(result), /Chrome CDP fixture/);
      return result;
    });
    assert.equal(readPage.details.url, pageUrl);

    // Snapshot returns stable refs for interactive elements.
    const snapshot = await runTool(tools, "chrome_snapshot", tabSelector);
    const items = snapshot.details.items ?? [];
    const nameRef = items.find((item) => item.tag === "input")?.ref;
    const applyRef = items.find((item) => (item.name || "").toLowerCase() === "apply")?.ref;
    assert.ok(nameRef, "snapshot should expose the name input ref");
    assert.ok(applyRef, "snapshot should expose the apply button ref");

    // Legacy selector path still works.
    await runTool(tools, "chrome_type", { ...tabSelector, selector: "#name", text: "Jasmine", clear: true });
    await runTool(tools, "chrome_click", { ...tabSelector, selector: "#apply" });
    const resultText = await runTool(tools, "chrome_read_page", { ...tabSelector, selector: "#result" });
    assert.match(textOf(resultText), /Hello Jasmine/);

    // Ref-based real-input path: retype via ref then submit, and re-click via ref.
    await runTool(tools, "chrome_type", { ...tabSelector, ref: nameRef, text: "Refbot", clear: true });
    await runTool(tools, "chrome_click", { ...tabSelector, ref: applyRef });
    const refResult = await eventually(async () => {
      const result = await runTool(tools, "chrome_read_page", { ...tabSelector, selector: "#result" });
      assert.match(textOf(result), /Hello Refbot/);
      return result;
    });
    assert.match(textOf(refResult), /Hello Refbot/);

    // Native select option by label dispatches change.
    await runTool(tools, "chrome_select_option", { ...tabSelector, selector: "#color", label: "Green" });
    const colorResult = await eventually(async () => {
      const result = await runTool(tools, "chrome_read_page", { ...tabSelector, selector: "#color-result" });
      assert.equal(result.details.text, "g");
      return result;
    });
    assert.equal(colorResult.details.text, "g");

    // Click then wait for an async DOM update.
    await runTool(tools, "chrome_click", { ...tabSelector, selector: "#delay" });
    const waited = await runTool(tools, "chrome_wait_for", { ...tabSelector, text: "ready", timeoutMs: 5000 });
    assert.match(textOf(waited), /Condition met/);

    // Evaluate returns a JSON-serializable value.
    const evaluated = await runTool(tools, "chrome_evaluate", { ...tabSelector, expression: "document.title" });
    assert.match(textOf(evaluated), /Chrome CDP fixture/);

    // Key press to the focused input types a character via real key events.
    await runTool(tools, "chrome_click", { ...tabSelector, ref: nameRef });
    await runTool(tools, "chrome_press_key", { ...tabSelector, key: "End" });

    // Tab management: open a blank tab, then close it.
    const newTab = await runTool(tools, "chrome_new_tab", {});
    const newTabId = newTab.details.tab?.id;
    assert.ok(newTabId, "new tab should report an id");
    await runTool(tools, "chrome_close_tab", { tabId: newTabId });

    // Navigate/reload the fixture tab and wait for load.
    const navigated = await runTool(tools, "chrome_navigate", { ...tabSelector, action: "reload", timeoutMs: 5000 });
    assert.equal(navigated.details.loaded, true);

    const screenshot = await runTool(tools, "chrome_screenshot", tabSelector);
    await access(screenshot.details.path);

    const localPreviewPath = path.join(tempDir, "local-preview.html");
    await writeFile(localPreviewPath, "<!doctype html><title>Local Jasmine Preview</title><h1>Local Jasmine Preview</h1>");
    const localPreview = await runTool(tools, "chrome_open_path", { path: localPreviewPath });
    assert.match(localPreview.details.url, /^file:\/\/\//);
    const localPreviewText = await eventually(async () => {
      const result = await runTool(tools, "chrome_read_page", { urlContains: "local-preview.html" });
      assert.match(textOf(result), /Local Jasmine Preview/);
      return result;
    });
    assert.match(localPreviewText.details.url, /^file:\/\/\//);
  }
} finally {
  await shutdownLaunchedChrome();
  if (previousEndpoint === undefined) delete process.env.CHROME_CDP_URL;
  else process.env.CHROME_CDP_URL = previousEndpoint;
  if (previousHeadless === undefined) delete process.env.CHROME_HEADLESS;
  else process.env.CHROME_HEADLESS = previousHeadless;
  if (previousUserDataDir === undefined) delete process.env.CHROME_USER_DATA_DIR;
  else process.env.CHROME_USER_DATA_DIR = previousUserDataDir;
  await closeServer(httpServer);
  await rm(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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

async function resolveBrowserExecutable() {
  const candidates = process.platform === "win32"
    ? [
        process.env.CHROME_EXECUTABLE,
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")
      ]
    : [
        process.env.CHROME_EXECUTABLE,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge"
      ];
  for (const candidate of candidates.filter(Boolean)) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

async function closedLocalEndpoint() {
  const server = createServer((_request, response) => {
    response.writeHead(503).end("not ready");
  });
  await listen(server);
  const port = server.address().port;
  await closeServer(server);
  return `http://127.0.0.1:${port}`;
}

async function rejectsWithMessage(fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
  assert.fail("Expected tool call to fail.");
}

async function eventually(fn, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError;
}
