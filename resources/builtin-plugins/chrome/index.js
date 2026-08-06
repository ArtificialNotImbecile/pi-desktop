import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
const MAX_TEXT_CHARS = 50000;
const ENDPOINT_WAIT_MS = 10000;
const BRIDGE_WAIT_MS = 15000;
const MAX_SNAPSHOT_ITEMS = 200;
const DEFAULT_WAIT_MS = 10000;

let launchedBrowser = null;
let launchedEndpoint = null;

function endpoint() {
  return (process.env.CHROME_CDP_URL || launchedEndpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

function setupHelp() {
  return [
    "Chrome uses Chrome DevTools Protocol.",
    `Expected endpoint: ${endpoint()}`,
    "",
    "Chrome can auto-launch an isolated profile when CHROME_CDP_URL is not set. To connect to your own Chrome instance, start Chrome with remote debugging enabled, then retry:",
    '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\\.jasmine\\chrome-cdp-profile"',
    "",
    "That isolated profile will not share your normal login state. To control your already-running normal Chrome with its real session, use the Jasmine Chrome takeover extension and native host instead of raw remote debugging (Chrome 136+ blocks remote debugging on the default profile)."
  ].join("\n");
}

function bridgeEnabled() {
  return process.env.JASMINE_CHROME_TAKEOVER === "1";
}

function bridgeInfoFilePath() {
  return process.env.JASMINE_CHROME_BRIDGE_FILE || path.join(homedir(), ".jasmine", "chrome-bridge.json");
}

async function readBridgeInfo() {
  const filePath = bridgeInfoFilePath();
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Jasmine Chrome takeover is enabled, but the bridge info file was not found at ${filePath}. Open Jasmine Settings > Chrome control and enable takeover.`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Jasmine Chrome takeover bridge info is invalid at ${filePath}.`, { cause: error });
  }
  const port = Number(parsed.port);
  const token = typeof parsed.token === "string" ? parsed.token : "";
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) {
    throw new Error(`Jasmine Chrome takeover bridge info is missing a valid port or token at ${filePath}.`);
  }
  return { port, token, filePath };
}

async function callBridge(method, params = {}, signal) {
  const info = await readBridgeInfo();
  const id = randomUUID();
  const socket = await connectBridge(info, signal);
  let settled = false;
  let buffer = "";
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      socket.destroy();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => fail(new Error("Chrome takeover bridge request was aborted."));
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for Chrome takeover bridge method ${method}.`)), BRIDGE_WAIT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            newlineIndex = buffer.indexOf("\n");
            continue;
          }
          if (message.id !== id) {
            newlineIndex = buffer.indexOf("\n");
            continue;
          }
          if (message.ok) done(message.result ?? {});
          else fail(new Error(message.error || "Chrome takeover bridge command failed."));
          return;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.once("error", (error) => fail(new Error(`Chrome takeover bridge connection failed: ${describeError(error)}`, { cause: error })));
    socket.once("close", () => fail(new Error("Chrome takeover bridge connection closed before a reply was received.")));
    socket.write(`${JSON.stringify({ type: "hello", token: info.token, role: "agent" })}\n`);
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function connectBridge(info, signal) {
  if (signal?.aborted) throw new Error("Chrome takeover bridge connection was aborted.");
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host: "127.0.0.1", port: info.port });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners("connect");
      socket.removeAllListeners("error");
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`Timed out connecting to Jasmine Chrome takeover bridge at ${info.filePath}.`)), 5000);
    const onAbort = () => fail(new Error("Chrome takeover bridge connection was aborted."));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    });
    socket.once("error", (error) => fail(new Error(`Could not connect to Jasmine Chrome takeover bridge at ${info.filePath}: ${describeError(error)}`, { cause: error })));
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Chrome DevTools request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function ensureCdpAvailable(signal) {
  const targetEndpoint = endpoint();
  const readiness = await endpointReadiness(targetEndpoint, signal);
  if (readiness.ok) return;
  if (process.env.CHROME_CDP_URL) {
    throw chromeEndpointNotReadyError("checking Chrome readiness", readiness.error);
  }
  await launchManagedChrome(signal);
}

async function endpointResponds(targetEndpoint, signal) {
  const readiness = await endpointReadiness(targetEndpoint, signal);
  return readiness.ok;
}

async function endpointReadiness(targetEndpoint, signal) {
  try {
    const response = await fetch(`${targetEndpoint}/json/version`, { signal });
    if (response.ok) return { ok: true };
    return {
      ok: false,
      error: new Error(`Chrome DevTools version endpoint returned ${response.status} ${response.statusText}`)
    };
  } catch (error) {
    if (signal?.aborted) throw new Error("Chrome readiness check was aborted.", { cause: error });
    return { ok: false, error };
  }
}

function chromeEndpointNotReadyError(action, cause) {
  const causeText = describeError(cause);
  const lastError = causeText ? ` Last error: ${causeText}.` : "";
  return new Error(
    `Chrome DevTools endpoint is not ready at ${endpoint()} while ${action}.${lastError} Retry after Chrome finishes starting or run chrome_status for setup details.\n\n${setupHelp()}`,
    { cause }
  );
}

function describeError(error, depth = 0) {
  if (!error || depth > 2) return "";
  const message = error instanceof Error
    ? (error.message || error.name || String(error))
    : String(error);
  const causeText = error instanceof Error && error.cause
    ? describeError(error.cause, depth + 1)
    : "";
  if (!causeText || causeText === message) return message;
  return `${message}; ${causeText}`;
}

async function launchManagedChrome(signal) {
  if (launchedBrowser && launchedEndpoint && await endpointResponds(launchedEndpoint, signal)) return;
  await shutdownLaunchedChrome();
  const executable = await resolveBrowserExecutable();
  if (!executable) throw new Error(`Chrome, Chromium, or Edge was not found.\n\n${setupHelp()}`);
  const port = await freePort();
  launchedEndpoint = `http://127.0.0.1:${port}`;
  await mkdir(managedUserDataDir(), { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${managedUserDataDir()}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--disable-background-networking",
    "about:blank"
  ];
  if (process.env.CHROME_HEADLESS === "1") {
    args.unshift("--headless=new", "--disable-gpu");
  }
  const child = spawn(executable, args, {
    stdio: "ignore",
    windowsHide: true
  });
  launchedBrowser = child;
  child.once("exit", () => {
    if (launchedBrowser === child) {
      launchedBrowser = null;
      launchedEndpoint = null;
    }
  });
  child.once("error", () => {
    if (launchedBrowser === child) {
      launchedBrowser = null;
      launchedEndpoint = null;
    }
  });
  await waitForEndpoint(`${launchedEndpoint}/json/version`, signal);
}

export async function shutdownLaunchedChrome() {
  const child = launchedBrowser;
  launchedBrowser = null;
  launchedEndpoint = null;
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForEndpoint(url, signal) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < ENDPOINT_WAIT_MS) {
    if (signal?.aborted) throw new Error("Chrome launch was aborted.");
    try {
      const response = await fetch(url, { signal });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for Chrome DevTools at ${url}.`, { cause: lastError });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
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

function managedUserDataDir() {
  if (process.env.CHROME_USER_DATA_DIR) return process.env.CHROME_USER_DATA_DIR;
  return path.join(homedir(), ".jasmine", "chrome-cdp-profile");
}

process.once("exit", () => {
  if (launchedBrowser && launchedBrowser.exitCode === null) launchedBrowser.kill();
});

async function listTargets(signal) {
  try {
    await ensureCdpAvailable(signal);
    const targets = await fetchJson(`${endpoint()}/json/list`, { signal });
    if (!Array.isArray(targets)) return [];
    return targets
      .filter((target) => target && target.type === "page" && typeof target.webSocketDebuggerUrl === "string")
      .map((target) => ({
        id: String(target.id ?? ""),
        title: String(target.title ?? ""),
        url: String(target.url ?? ""),
        webSocketDebuggerUrl: String(target.webSocketDebuggerUrl)
      }));
  } catch (error) {
    throw new Error(`Chrome DevTools endpoint is unavailable at ${endpoint()}.\n\n${setupHelp()}`, { cause: error });
  }
}

async function resolveTarget(params = {}, signal) {
  const targets = await listTargets(signal);
  if (targets.length === 0) throw new Error(`No controllable Chrome tabs found.\n\n${setupHelp()}`);
  if (typeof params.tabId === "string" && params.tabId.trim()) {
    const target = targets.find((item) => item.id === params.tabId.trim());
    if (!target) throw new Error(`Chrome tab not found: ${params.tabId}`);
    return target;
  }
  if (typeof params.urlContains === "string" && params.urlContains.trim()) {
    const needle = params.urlContains.trim().toLowerCase();
    const target = targets.find((item) => item.url.toLowerCase().includes(needle));
    if (!target) throw new Error(`No Chrome tab URL contains: ${params.urlContains}`);
    return target;
  }
  return targets.find((item) => item.url && item.url !== "about:blank") ?? targets[0];
}

class CdpClient {
  constructor(wsUrl, signal) {
    this.wsUrl = wsUrl;
    this.signal = signal;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
    this.abortHandler = () => this.close();
  }

  async open() {
    if (typeof WebSocket !== "function") {
      throw new Error("This runtime does not expose WebSocket, so Chrome cannot connect to CDP.");
    }
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    this.ws.addEventListener("close", () => this.rejectAll(new Error("Chrome DevTools connection closed.")));
    this.ws.addEventListener("error", () => this.rejectAll(new Error("Chrome DevTools connection failed.")));
    this.signal?.addEventListener("abort", this.abortHandler, { once: true });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to Chrome DevTools.")), 5000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Failed to connect to Chrome DevTools."));
      }, { once: true });
    });
  }

  async call(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Chrome DevTools connection is not open.");
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}.`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.ws.send(payload);
    return response;
  }

  onMessage(event) {
    let raw = event.data;
    if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString("utf8");
    if (ArrayBuffer.isView(raw)) raw = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
    if (typeof raw !== "string") return;
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error.message || "Chrome DevTools command failed."));
    else pending.resolve(message.result ?? {});
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.signal?.removeEventListener("abort", this.abortHandler);
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    this.ws = null;
  }
}

async function withCdp(params, signal, fn) {
  const target = await resolveTarget(params, signal);
  const client = new CdpClient(target.webSocketDebuggerUrl, signal);
  await client.open();
  try {
    return await fn(client, target);
  } finally {
    client.close();
  }
}

function safeHttpUrl(input) {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported.");
  return url.toString();
}

async function safeFileUrl(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new Error("Local path is required.");
  const filePath = path.resolve(inputPath);
  await access(filePath);
  return pathToFileURL(filePath).toString();
}

// Injected page helpers. These functions contain no `${}` so they stay literal
// when composed into a Runtime.evaluate expression below.
const PAGE_HELPERS = `
function __jmVisible(el){
  if(!el) return false;
  const style=getComputedStyle(el);
  if(style.visibility==="hidden"||style.display==="none"||Number(style.opacity)===0) return false;
  const rect=el.getBoundingClientRect();
  return rect.width>0 && rect.height>0;
}
function __jmName(el){
  const raw=el.getAttribute("aria-label")||el.innerText||el.value||el.getAttribute("placeholder")||el.getAttribute("alt")||el.getAttribute("title")||"";
  return String(raw).replace(/\\s+/g," ").trim().slice(0,120);
}
function __jmResolve(p){
  let el=null;
  if(p.ref){ el=document.querySelector('[data-jm-ref="'+p.ref+'"]'); }
  if(!el && p.selector){ el=document.querySelector(p.selector); }
  if(!el && p.text){
    const n=String(p.text).toLowerCase();
    el=Array.from(document.querySelectorAll("button,a,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[tabindex],label,summary"))
      .find((x)=>__jmVisible(x) && ((x.innerText||x.value||x.getAttribute("aria-label")||x.getAttribute("title")||"").toLowerCase().includes(n)));
  }
  if(!el) return {ok:false,reason:"element not found"};
  el.scrollIntoView({block:"center",inline:"center"});
  const r=el.getBoundingClientRect();
  const cx=Math.max(0,Math.min(window.innerWidth-1, r.left+r.width/2));
  const cy=Math.max(0,Math.min(window.innerHeight-1, r.top+r.height/2));
  return {ok:true,x:cx,y:cy,left:r.left,top:r.top,width:r.width,height:r.height,tag:el.tagName,type:el.getAttribute("type")||"",name:__jmName(el),editable:(el.isContentEditable||("value" in el)),url:location.href};
}
function __jmSnapshot(maxItems){
  document.querySelectorAll("[data-jm-ref]").forEach((el)=>el.removeAttribute("data-jm-ref"));
  const sel="a,button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[contenteditable=''],[contenteditable=true],[onclick],[tabindex],summary";
  const nodes=Array.from(document.querySelectorAll(sel)).filter(__jmVisible);
  const items=[];
  let index=1;
  for(const el of nodes){
    if(items.length>=maxItems) break;
    const ref="e"+(index++);
    el.setAttribute("data-jm-ref",ref);
    const tag=el.tagName.toLowerCase();
    const role=el.getAttribute("role")||tag;
    items.push({
      ref:ref,
      tag:tag,
      role:role,
      type:el.getAttribute("type")||"",
      name:__jmName(el),
      value:("value" in el && el.value!=null)?String(el.value).slice(0,80):"",
      href:el.getAttribute("href")||"",
      disabled:Boolean(el.disabled)
    });
  }
  return {title:document.title,url:location.href,count:items.length,items:items};
}
`;

const KEY_DEFS = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Space: { key: " ", code: "Space", vk: 32, text: " " }
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 };

function keyDefinition(key) {
  if (KEY_DEFS[key]) return KEY_DEFS[key];
  const char = String(key);
  const upper = char.toUpperCase();
  return {
    key: char,
    code: /^[a-zA-Z]$/.test(char) ? `Key${upper}` : (/^[0-9]$/.test(char) ? `Digit${char}` : ""),
    vk: upper.charCodeAt(0) || 0,
    text: char.length === 1 ? char : undefined
  };
}

function modifierBits(modifiers = []) {
  return modifiers.reduce((bits, name) => bits | (MODIFIER_BITS[name] ?? 0), 0);
}

async function runtimeEval(client, expression, awaitPromise = false) {
  const result = await client.call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Chrome page evaluation failed.");
  }
  return result.result?.value;
}

function locatorFrom(params) {
  return { ref: params.ref ?? null, selector: params.selector ?? null, text: params.text ?? null };
}

async function resolveElement(client, params) {
  const value = await runtimeEval(client, `(() => { ${PAGE_HELPERS}; return __jmResolve(${JSON.stringify(locatorFrom(params))}); })()`);
  if (!value?.ok) throw new Error(value?.reason || "Element not found.");
  return value;
}

async function dispatchClick(client, x, y) {
  await client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await client.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await client.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function dispatchKey(client, key, modifiers = 0) {
  const def = keyDefinition(key);
  const base = {
    modifiers,
    key: def.key,
    code: def.code || undefined,
    windowsVirtualKeyCode: def.vk || undefined,
    nativeVirtualKeyCode: def.vk || undefined
  };
  const suppressText = (modifiers & MODIFIER_BITS.Control) || (modifiers & MODIFIER_BITS.Meta) || (modifiers & MODIFIER_BITS.Alt);
  const down = { type: "keyDown", ...base };
  if (def.text && !suppressText) down.text = def.text;
  await client.call("Input.dispatchKeyEvent", down);
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function focusAndClear(client, params, clear) {
  const element = await resolveElement(client, params);
  await dispatchClick(client, element.x, element.y);
  if (clear) {
    await dispatchKey(client, "a", MODIFIER_BITS.Control);
    await dispatchKey(client, "Delete");
  }
  return element;
}

function toolText(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details
  };
}

function clampMaxChars(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_TEXT_CHARS;
  return Math.max(1000, Math.min(MAX_TEXT_CHARS, Math.floor(value)));
}

function clampWaitMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WAIT_MS;
  return Math.max(200, Math.min(60000, Math.floor(value)));
}

function quote(value) {
  return JSON.stringify(value ?? "");
}

async function createNewTab(safeUrl, signal) {
  await ensureCdpAvailable(signal);
  const candidateUrls = [
    `${endpoint()}/json/new?${encodeURIComponent(safeUrl)}`,
    `${endpoint()}/json/new?${new URLSearchParams({ url: safeUrl }).toString()}`
  ];
  let lastResponse = null;
  let lastError = null;
  for (const candidate of candidateUrls) {
    for (const method of ["PUT", "GET"]) {
      let response;
      try {
        response = await fetch(candidate, { method, signal });
      } catch (error) {
        if (signal?.aborted) throw new Error("Chrome open request was aborted.", { cause: error });
        lastError = error;
        continue;
      }
      if (response.ok) return response.json();
      lastResponse = response;
      if (response.status !== 404 && response.status !== 405) break;
    }
  }
  if (lastError && !lastResponse) {
    throw chromeEndpointNotReadyError("opening a new Chrome tab", lastError);
  }
  throw new Error(`Chrome could not open URL: ${lastResponse?.status ?? "unknown"} ${lastResponse?.statusText ?? ""}`.trim());
}

async function closeTab(tabId, signal) {
  await ensureCdpAvailable(signal);
  const response = await fetch(`${endpoint()}/json/close/${encodeURIComponent(tabId)}`, { signal });
  if (!response.ok) throw new Error(`Chrome could not close tab ${tabId}: ${response.status} ${response.statusText}`);
}

async function activateTab(tabId, signal) {
  await ensureCdpAvailable(signal);
  const response = await fetch(`${endpoint()}/json/activate/${encodeURIComponent(tabId)}`, { signal });
  if (!response.ok) throw new Error(`Chrome could not activate tab ${tabId}: ${response.status} ${response.statusText}`);
}

async function waitForLoad(client, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ready = await runtimeEval(client, "document.readyState");
    if (ready === "complete") return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function saveScreenshot(params, signal) {
  return withCdp(params, signal, async (client, target) => {
    await client.call("Page.enable");
    let clip;
    if (params.ref || params.selector) {
      const element = await resolveElement(client, params);
      if (element.width > 0 && element.height > 0) {
        clip = { x: element.left, y: element.top, width: element.width, height: element.height, scale: 1 };
      }
    }
    const result = await client.call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: Boolean(params.fullPage),
      ...(clip ? { clip } : {})
    });
    if (typeof result.data !== "string" || !result.data) throw new Error("Chrome returned an empty screenshot.");
    const dir = path.join(tmpdir(), "chrome-cdp");
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `chrome-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
    await writeFile(filePath, Buffer.from(result.data, "base64"));
    return toolText(`Saved Chrome screenshot: ${filePath}`, {
      tabId: target.id,
      title: target.title,
      url: target.url,
      path: filePath
    });
  });
}

async function bridgeStatus(signal) {
  const status = await callBridge("status", {}, signal);
  const tabCount = Number(status.tabCount ?? 0);
  return toolText(`Connected to Jasmine Chrome takeover bridge with ${tabCount} real Chrome tab(s).`, {
    ...status,
    connected: true,
    takeover: true,
    bridgeFile: bridgeInfoFilePath()
  });
}

function formatTabs(tabs = []) {
  const normalized = Array.isArray(tabs)
    ? tabs.map((tab) => ({
        id: String(tab.id ?? ""),
        title: String(tab.title ?? ""),
        url: String(tab.url ?? ""),
        active: Boolean(tab.active)
      }))
    : [];
  const text = normalized.length
    ? normalized.map((tab, index) => `${index + 1}. ${tab.title || "(untitled)"}${tab.active ? " (active)" : ""}\n   id: ${tab.id}\n   url: ${tab.url}`).join("\n\n")
    : "No controllable Chrome tabs found.";
  return { text, tabs: normalized };
}

function formatSnapshot(snapshot = {}, fallback = {}) {
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const lines = items.map((item) => {
    const parts = [`[${item.ref}] ${item.tag}`];
    if (item.type) parts.push(`[${item.type}]`);
    if (item.role && item.role !== item.tag) parts.push(`role=${item.role}`);
    if (item.name) parts.push(`"${item.name}"`);
    if (item.value) parts.push(`value="${item.value}"`);
    if (item.href) parts.push(`-> ${item.href}`);
    if (item.disabled) parts.push("(disabled)");
    return parts.join(" ");
  });
  const header = [`Title: ${snapshot.title || fallback.title || "(untitled)"}`, `URL: ${snapshot.url || fallback.url || ""}`, `Elements: ${items.length}`, ""].join("\n");
  return toolText(header + (lines.join("\n") || "(no interactive elements found)"), {
    tabId: snapshot.tabId ?? fallback.tabId,
    title: snapshot.title,
    url: snapshot.url,
    items,
    takeover: true
  });
}

function formatReadPage(page = {}, fallback = {}) {
  const text = [
    `Title: ${page.title || fallback.title || "(untitled)"}`,
    `URL: ${page.url || fallback.url || ""}`,
    "",
    page.text || "(no visible text)"
  ].join("\n");
  return toolText(text, { ...page, tabId: page.tabId ?? fallback.tabId, takeover: true });
}

function stringifyValue(value) {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function saveBridgeScreenshot(params, signal) {
  const result = await callBridge("screenshot", params, signal);
  if (typeof result.dataBase64 !== "string" || !result.dataBase64) throw new Error("Chrome takeover returned an empty screenshot.");
  const dir = path.join(tmpdir(), "chrome-cdp");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `chrome-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
  await writeFile(filePath, Buffer.from(result.dataBase64, "base64"));
  return toolText(`Saved Chrome screenshot: ${filePath}`, {
    tabId: result.tabId,
    title: result.title,
    url: result.url,
    path: filePath,
    takeover: true
  });
}

const TAB_LOCATOR_PARAMS = {
  tabId: Type.Optional(Type.String({ description: "Tab id from chrome_list_tabs." })),
  urlContains: Type.Optional(Type.String({ description: "Pick the first tab whose URL contains this text." }))
};

const ELEMENT_LOCATOR_PARAMS = {
  ...TAB_LOCATOR_PARAMS,
  ref: Type.Optional(Type.String({ description: "Element ref from chrome_snapshot (e.g. e12). Preferred addressing." })),
  selector: Type.Optional(Type.String({ description: "CSS selector when no ref is available." })),
  text: Type.Optional(Type.String({ description: "Visible text to match when no ref or selector is available." }))
};

export default function chrome(pi) {
  pi.registerTool({
    name: "chrome_status",
    label: "Chrome status",
    description: "Check whether Chrome DevTools Protocol is reachable.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      if (bridgeEnabled()) {
        return bridgeStatus(signal).catch((error) => toolText(error instanceof Error ? error.message : String(error), {
          connected: false,
          takeover: true,
          bridgeFile: bridgeInfoFilePath()
        }));
      }
      const targets = await listTargets(signal).catch((error) => {
        return { error: error instanceof Error ? error.message : String(error) };
      });
      if (!Array.isArray(targets)) return toolText(targets.error, { connected: false, endpoint: endpoint() });
      return toolText(`Connected to Chrome DevTools at ${endpoint()} with ${targets.length} controllable tab(s).`, {
        connected: true,
        endpoint: endpoint(),
        tabCount: targets.length
      });
    }
  });

  pi.registerTool({
    name: "chrome_list_tabs",
    label: "List Chrome tabs",
    description: "List controllable Chrome tabs exposed by the configured DevTools endpoint.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      if (bridgeEnabled()) {
        const result = await callBridge("list_tabs", {}, signal);
        const { text, tabs } = formatTabs(result.tabs);
        return toolText(text, { tabs, takeover: true });
      }
      const targets = await listTargets(signal);
      const text = targets.length
        ? targets.map((target, index) => `${index + 1}. ${target.title || "(untitled)"}\n   id: ${target.id}\n   url: ${target.url}`).join("\n\n")
        : "No controllable Chrome tabs found.";
      return toolText(text, { tabs: targets.map(({ webSocketDebuggerUrl, ...target }) => target) });
    }
  });

  pi.registerTool({
    name: "chrome_open_url",
    label: "Open Chrome URL",
    description: "Open an http or https URL in a new Chrome tab through DevTools. This changes browser state.",
    promptGuidelines: [
      "Use this only when the user asks to inspect or navigate the browser.",
      "Do not open sensitive, login, payment, account, or form-submission pages unless the user explicitly requested that destination."
    ],
    parameters: Type.Object({
      url: Type.String({ description: "HTTP or HTTPS URL to open." })
    }),
    async execute(_toolCallId, params, signal) {
      if (bridgeEnabled()) {
        const url = safeHttpUrl(params.url);
        const target = await callBridge("new_tab", { url }, signal);
        return toolText(`Opened Chrome URL: ${target.url ?? url}`, { tab: target, takeover: true });
      }
      const target = await createNewTab(safeHttpUrl(params.url), signal);
      return toolText(`Opened Chrome URL: ${target.url ?? params.url}`, { tab: target });
    }
  });

  pi.registerTool({
    name: "chrome_open_path",
    label: "Open Chrome file",
    description: "Open a local HTML file or other local file path in the managed Chrome CDP browser. Prefer this for static previews created during the current task.",
    promptGuidelines: [
      "Use this for local static HTML previews instead of starting an ad hoc HTTP server.",
      "Only open local files that the user asked to inspect or files created for the current task."
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or workspace-relative local file path to open in Chrome." })
    }),
    async execute(_toolCallId, params, signal) {
      const url = await safeFileUrl(params.path);
      if (bridgeEnabled()) {
        const target = await callBridge("new_tab", { url }, signal);
        return toolText(`Opened Chrome file: ${params.path}`, { tab: target, url, takeover: true });
      }
      const target = await createNewTab(url, signal);
      return toolText(`Opened Chrome file: ${params.path}`, { tab: target, url });
    }
  });

  pi.registerTool({
    name: "chrome_new_tab",
    label: "New Chrome tab",
    description: "Open a new Chrome tab, optionally at a URL. This changes browser state.",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Optional http or https URL. Defaults to a blank tab." }))
    }),
    async execute(_toolCallId, params = {}, signal) {
      const url = params.url ? safeHttpUrl(params.url) : "about:blank";
      if (bridgeEnabled()) {
        const target = await callBridge("new_tab", { url }, signal);
        return toolText(`Opened new Chrome tab: ${target.url ?? url}`, { tab: target, takeover: true });
      }
      const target = await createNewTab(url, signal);
      return toolText(`Opened new Chrome tab: ${target.url ?? url}`, { tab: target });
    }
  });

  pi.registerTool({
    name: "chrome_close_tab",
    label: "Close Chrome tab",
    description: "Close a Chrome tab by id. This changes browser state.",
    promptGuidelines: ["Only close tabs the user asked to close, or tabs this task created."],
    parameters: Type.Object({
      tabId: Type.String({ description: "Tab id from chrome_list_tabs." })
    }),
    async execute(_toolCallId, params, signal) {
      if (bridgeEnabled()) {
        await callBridge("close_tab", params, signal);
        return toolText(`Closed Chrome tab: ${params.tabId}`, { tabId: params.tabId, takeover: true });
      }
      await closeTab(params.tabId, signal);
      return toolText(`Closed Chrome tab: ${params.tabId}`, { tabId: params.tabId });
    }
  });

  pi.registerTool({
    name: "chrome_activate_tab",
    label: "Activate Chrome tab",
    description: "Bring a Chrome tab to the foreground by id.",
    parameters: Type.Object({
      tabId: Type.String({ description: "Tab id from chrome_list_tabs." })
    }),
    async execute(_toolCallId, params, signal) {
      if (bridgeEnabled()) {
        await callBridge("activate_tab", params, signal);
        return toolText(`Activated Chrome tab: ${params.tabId}`, { tabId: params.tabId, takeover: true });
      }
      await activateTab(params.tabId, signal);
      return toolText(`Activated Chrome tab: ${params.tabId}`, { tabId: params.tabId });
    }
  });

  pi.registerTool({
    name: "chrome_navigate",
    label: "Navigate Chrome tab",
    description: "Navigate a Chrome tab to a URL, or go back/forward/reload, then wait for load. This changes browser state.",
    promptGuidelines: [
      "Do not navigate to sensitive, login, payment, or account pages unless the user explicitly requested that destination."
    ],
    parameters: Type.Object({
      ...TAB_LOCATOR_PARAMS,
      url: Type.Optional(Type.String({ description: "HTTP or HTTPS URL to navigate the current tab to." })),
      action: Type.Optional(Type.String({ description: "One of back, forward, or reload when no URL is given." })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Max time to wait for load, 200-60000 ms." }))
    }),
    async execute(_toolCallId, params = {}, signal) {
      if (bridgeEnabled()) {
        const bridgeParams = { ...params, ...(params.url ? { url: safeHttpUrl(params.url) } : {}) };
        const result = await callBridge("navigate", bridgeParams, signal);
        const loaded = result.loaded !== false;
        return toolText(`Navigated to ${result.url ?? params.url ?? params.action}${loaded ? "" : " (load wait timed out)"}`, {
          ...result,
          loaded,
          takeover: true
        });
      }
      return withCdp(params, signal, async (client, target) => {
        await client.call("Page.enable");
        if (params.url) {
          await client.call("Page.navigate", { url: safeHttpUrl(params.url) });
        } else if (params.action === "reload") {
          await client.call("Page.reload", {});
        } else if (params.action === "back") {
          await runtimeEval(client, "history.back()");
        } else if (params.action === "forward") {
          await runtimeEval(client, "history.forward()");
        } else {
          throw new Error("Provide a url or an action of back, forward, or reload.");
        }
        const loaded = await waitForLoad(client, clampWaitMs(params.timeoutMs));
        const value = await runtimeEval(client, "({ url: location.href, title: document.title })");
        return toolText(`Navigated to ${value?.url ?? params.url ?? params.action}${loaded ? "" : " (load wait timed out)"}`, {
          tabId: target.id,
          loaded,
          ...(value ?? {})
        });
      });
    }
  });

  pi.registerTool({
    name: "chrome_snapshot",
    label: "Snapshot Chrome page",
    description: "Return an indexed snapshot of interactive and notable elements in a Chrome tab, each with a stable ref (e.g. e12) usable by chrome_click, chrome_type, chrome_hover, chrome_scroll, and chrome_screenshot. Prefer this over guessing CSS selectors.",
    parameters: Type.Object({
      ...TAB_LOCATOR_PARAMS,
      maxItems: Type.Optional(Type.Integer({ description: `Max elements to return, up to ${MAX_SNAPSHOT_ITEMS}.` }))
    }),
    async execute(_toolCallId, params = {}, signal) {
      const maxItems = Math.max(1, Math.min(MAX_SNAPSHOT_ITEMS, Math.floor(params.maxItems ?? MAX_SNAPSHOT_ITEMS)));
      if (bridgeEnabled()) {
        const snapshot = await callBridge("snapshot", { ...params, maxItems }, signal);
        return formatSnapshot(snapshot);
      }
      return withCdp(params, signal, async (client, target) => {
        const snapshot = await runtimeEval(client, `(() => { ${PAGE_HELPERS}; return __jmSnapshot(${maxItems}); })()`);
        const items = snapshot?.items ?? [];
        const lines = items.map((item) => {
          const parts = [`[${item.ref}] ${item.tag}`];
          if (item.type) parts.push(`[${item.type}]`);
          if (item.role && item.role !== item.tag) parts.push(`role=${item.role}`);
          if (item.name) parts.push(`"${item.name}"`);
          if (item.value) parts.push(`value="${item.value}"`);
          if (item.href) parts.push(`-> ${item.href}`);
          if (item.disabled) parts.push("(disabled)");
          return parts.join(" ");
        });
        const header = [`Title: ${snapshot?.title || target.title || "(untitled)"}`, `URL: ${snapshot?.url || target.url}`, `Elements: ${items.length}`, ""].join("\n");
        return toolText(header + (lines.join("\n") || "(no interactive elements found)"), {
          tabId: target.id,
          title: snapshot?.title,
          url: snapshot?.url,
          items
        });
      });
    }
  });

  pi.registerTool({
    name: "chrome_read_page",
    label: "Read Chrome page",
    description: "Read visible text, title, URL, and selected metadata from a Chrome tab.",
    parameters: Type.Object({
      ...TAB_LOCATOR_PARAMS,
      selector: Type.Optional(Type.String({ description: "Optional CSS selector to read instead of document.body." })),
      maxChars: Type.Optional(Type.Integer({ description: "Maximum characters to return, between 1000 and 50000." }))
    }),
    async execute(_toolCallId, params = {}, signal) {
      const maxChars = clampMaxChars(params.maxChars);
      const selector = typeof params.selector === "string" && params.selector.trim() ? params.selector.trim() : null;
      if (bridgeEnabled()) {
        const page = await callBridge("read_page", { ...params, maxChars, selector }, signal);
        return formatReadPage(page);
      }
      const expression = `(() => {
        const node = ${selector ? `document.querySelector(${quote(selector)})` : "document.body"};
        const text = node ? (node.innerText || node.textContent || "").replace(/\\n{3,}/g, "\\n\\n").trim() : "";
        return {
          title: document.title,
          url: location.href,
          text: text.slice(0, ${maxChars}),
          truncated: text.length > ${maxChars}
        };
      })()`;
      return withCdp(params, signal, async (client, target) => {
        const page = (await runtimeEval(client, expression)) ?? {};
        const text = [
          `Title: ${page.title || target.title || "(untitled)"}`,
          `URL: ${page.url || target.url}`,
          "",
          page.text || "(no visible text)"
        ].join("\n");
        return toolText(text, { tabId: target.id, ...page });
      });
    }
  });

  pi.registerTool({
    name: "chrome_click",
    label: "Click Chrome page",
    description: "Click an element in a Chrome tab by ref (from chrome_snapshot), CSS selector, or visible text, using real mouse events. This can trigger page actions.",
    promptGuidelines: [
      "Prefer a ref from chrome_snapshot; fall back to selector, then text.",
      "Do not click buttons that submit forms, purchase items, change permissions, delete data, or send messages unless the user explicitly requested that action."
    ],
    parameters: Type.Object(ELEMENT_LOCATOR_PARAMS),
    async execute(_toolCallId, params = {}, signal) {
      if (!params.ref && !params.selector && !params.text) throw new Error("Provide a ref, selector, or text.");
      if (bridgeEnabled()) {
        const element = await callBridge("click", params, signal);
        return toolText(`Clicked Chrome element: ${element.name || element.tag}`, { ...element, takeover: true });
      }
      return withCdp(params, signal, async (client, target) => {
        const element = await resolveElement(client, params);
        await dispatchClick(client, element.x, element.y);
        return toolText(`Clicked Chrome element: ${element.name || element.tag}`, { tabId: target.id, ...element });
      });
    }
  });

  pi.registerTool({
    name: "chrome_type",
    label: "Type in Chrome page",
    description: "Focus an input, textarea, or contenteditable element by ref, CSS selector, or text and type using real keyboard events. Optionally submit with Enter. This changes page state.",
    promptGuidelines: [
      "Do not type passwords, payment data, API keys, private identifiers, or other sensitive data unless the user explicitly asked to enter that exact data on that site.",
      "Set submit only when the user wants to submit the form or run the search."
    ],
    parameters: Type.Object({
      ...ELEMENT_LOCATOR_PARAMS,
      selector: Type.Optional(Type.String({ description: "CSS selector for the editable element when no ref is available." })),
      text: Type.String({ description: "Text to enter." }),
      clear: Type.Optional(Type.Boolean({ description: "Clear existing value before typing. Defaults to true." })),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing. Defaults to false." }))
    }),
    async execute(_toolCallId, params = {}, signal) {
      if (!params.ref && !params.selector) throw new Error("Provide a ref or selector for the editable element.");
      if (bridgeEnabled()) {
        const element = await callBridge("type", params, signal);
        return toolText(`Typed into Chrome element: ${element.name || params.ref || params.selector}`, { ...element, submit: Boolean(params.submit), takeover: true });
      }
      return withCdp(params, signal, async (client, target) => {
        const element = await focusAndClear(client, params, params.clear !== false);
        if (params.text) await client.call("Input.insertText", { text: String(params.text) });
        if (params.submit) await dispatchKey(client, "Enter");
        return toolText(`Typed into Chrome element: ${element.name || params.ref || params.selector}`, { tabId: target.id, submit: Boolean(params.submit), ...element });
      });
    }
  });

  pi.registerTool({
    name: "chrome_press_key",
    label: "Press key in Chrome",
    description: "Dispatch a real keyboard key to the focused element in a Chrome tab, optionally with modifiers.",
    promptGuidelines: ["Use for navigation keys, Enter, Escape, Tab, or shortcuts the user requested."],
    parameters: Type.Object({
      ...TAB_LOCATOR_PARAMS,
      key: Type.String({ description: "Key name such as Enter, Tab, Escape, ArrowDown, or a single character." }),
      modifiers: Type.Optional(Type.Array(Type.String({ description: "One of Alt, Control, Meta, Shift." })))
    }),
    async execute(_toolCallId, params = {}, signal) {
      if (bridgeEnabled()) {
        const result = await callBridge("press_key", params, signal);
        return toolText(`Pressed key in Chrome: ${(params.modifiers ?? []).concat(params.key).join("+")}`, { ...result, key: params.key, takeover: true });
      }
      return withCdp(params, signal, async (client, target) => {
        await dispatchKey(client, params.key, modifierBits(params.modifiers ?? []));
        return toolText(`Pressed key in Chrome: ${(params.modifiers ?? []).concat(params.key).join("+")}`, { tabId: target.id, key: params.key });
      });
    }
  });

  pi.registerTool({
    name: "chrome_scroll",
    label: "Scroll Chrome page",
    description: "Scroll a Chrome tab by direction and amount, or scroll a specific element (by ref/selector) into view.",
    parameters: Type.Object({
      ...ELEMENT_LOCATOR_PARAMS,
      direction: Type.Optional(Type.String({ description: "One of up, down, left, right. Defaults to down." })),
      amount: Type.Optional(Type.Integer({ description: "Pixels to scroll. Defaults to one viewport height/width." }))
    }),
    async execute(_toolCallId, params = {}, signal) {
      if (bridgeEnabled()) {
        const result = await callBridge("scroll", params, signal);
        const direction = ["up", "down", "left", "right"].includes(params.direction) ? params.direction : "down";
        return toolText(result.name || result.tag ? `Scrolled element into view: ${result.name || result.tag}` : `Scrolled ${direction}`, {
          ...result,
          direction,
          takeover: true
        });
      }
      return withCdp(params, signal, async (client, target) => {
        if (params.ref || params.selector || params.text) {
          const element = await resolveElement(client, params);
          return toolText(`Scrolled element into view: ${element.name || element.tag}`, { tabId: target.id, ...element });
        }
        const direction = ["up", "down", "left", "right"].includes(params.direction) ? params.direction : "down";
        const value = await runtimeEval(client, `(() => {
          const dir = ${quote(direction)};
          const amount = ${Number.isFinite(params.amount) ? Math.floor(params.amount) : 0};
          const dx = dir === "left" ? -(amount || window.innerWidth) : dir === "right" ? (amount || window.innerWidth) : 0;
          const dy = dir === "up" ? -(amount || window.innerHeight) : dir === "down" ? (amount || window.innerHeight) : 0;
          window.scrollBy(dx, dy);
          return { scrollX: window.scrollX, scrollY: window.scrollY };
        })()`);
        return toolText(`Scrolled ${direction}`, { tabId: target.id, direction, ...(value ?? {}) });
      });
    }
  });

  pi.registerTool({
    name: "chrome_hover",
    label: "Hover Chrome element",
    description: "Move the mouse over an element in a Chrome tab by ref, selector, or text using a real mouse move event.",
    parameters: Type.Object(ELEMENT_LOCATOR_PARAMS),
    async execute(_toolCallId, params = {}, signal) {
      if (!params.ref && !params.selector && !params.text) throw new Error("Provide a ref, selector, or text.");
      if (bridgeEnabled()) {
        const element = await callBridge("hover", params, signal);
        return toolText(`Hovered Chrome element: ${element.name || element.tag}`, { ...element, takeover: true });
      }
      return withCdp(params, signal, async (client, target) => {
        const element = await resolveElement(client, params);
        await client.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: element.x, y: element.y, buttons: 0 });
        return toolText(`Hovered Chrome element: ${element.name || element.tag}`, { tabId: target.id, ...element });
      });
    }
  });

  pi.registerTool({
    name: "chrome_select_option",
    label: "Select Chrome option",
    description: "Select an option in a native <select> element by value or visible label.",
    parameters: Type.Object({
      ...ELEMENT_LOCATOR_PARAMS,
      value: Type.Optional(Type.String({ description: "Option value to select." })),
      label: Type.Optional(Type.String({ description: "Option visible label to select." }))
    }),
    async execute(_toolCallId, params = {}, signal) {
      if (!params.value && !params.label) throw new Error("Provide a value or label to select.");
      if (bridgeEnabled()) {
        const result = await callBridge("select_option", params, signal);
        return toolText(`Selected Chrome option: ${result.label || result.value}`, { ...result, takeover: true });
      }
      return withCdp(params, signal, async (client, target) => {
        const value = await runtimeEval(client, `(() => {
          ${PAGE_HELPERS};
          const r = __jmResolve(${JSON.stringify(locatorFrom(params))});
          if (!r.ok) return r;
          const el = document.querySelector('[data-jm-ref="' + (${quote(params.ref ?? "")}) + '"]') || ${params.selector ? `document.querySelector(${quote(params.selector)})` : "null"};
          if (!el || el.tagName !== "SELECT") return { ok: false, reason: "element is not a <select>" };
          const wantValue = ${quote(params.value ?? "")};
          const wantLabel = ${quote(params.label ?? "")};
          const option = Array.from(el.options).find((o) => (wantValue && o.value === wantValue) || (wantLabel && (o.label || o.textContent || "").trim() === wantLabel));
          if (!option) return { ok: false, reason: "option not found" };
          el.value = option.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, value: option.value, label: (option.label || option.textContent || "").trim(), url: location.href };
        })()`);
        if (!value?.ok) throw new Error(value?.reason || "Select failed.");
        return toolText(`Selected Chrome option: ${value.label || value.value}`, { tabId: target.id, ...value });
      });
    }
  });

  pi.registerTool({
    name: "chrome_wait_for",
    label: "Wait in Chrome",
    description: "Wait until a selector appears or disappears, page text is present, or the page finishes loading in a Chrome tab.",
    parameters: Type.Object({
      ...TAB_LOCATOR_PARAMS,
      selector: Type.Optional(Type.String({ description: "CSS selector to wait for." })),
      gone: Type.Optional(Type.Boolean({ description: "Wait for the selector to disappear instead of appear." })),
      text: Type.Optional(Type.String({ description: "Wait until this text is present in the page." })),
      state: Type.Optional(Type.String({ description: "Set to load to wait for document.readyState complete." })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Max time to wait, 200-60000 ms." }))
    }),
    async execute(_toolCallId, params = {}, signal) {
      const timeoutMs = clampWaitMs(params.timeoutMs);
      let condition;
      let label;
      if (params.selector) {
        condition = params.gone ? `!document.querySelector(${quote(params.selector)})` : `!!document.querySelector(${quote(params.selector)})`;
        label = `${params.gone ? "absence of" : "presence of"} ${params.selector}`;
      } else if (params.text) {
        condition = `(document.body && (document.body.innerText || "").toLowerCase().includes(${quote(params.text)}.toLowerCase()))`;
        label = `text "${params.text}"`;
      } else {
        condition = `document.readyState === "complete"`;
        label = "page load";
      }
      if (bridgeEnabled()) {
        const result = await callBridge("wait_for", { ...params, timeoutMs }, signal);
        return toolText(`Condition met: ${result.label || label}`, { ...result, takeover: true });
      }
      return withCdp(params, signal, async (client, target) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          if (signal?.aborted) throw new Error("Chrome wait was aborted.");
          const met = await runtimeEval(client, `Boolean(${condition})`);
          if (met) return toolText(`Condition met: ${label}`, { tabId: target.id, waitedMs: Date.now() - startedAt });
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
      });
    }
  });

  pi.registerTool({
    name: "chrome_screenshot",
    label: "Screenshot Chrome page",
    description: "Capture a PNG screenshot from a Chrome tab and save it to a temporary local file. Optionally clip to an element by ref or selector.",
    parameters: Type.Object({
      ...TAB_LOCATOR_PARAMS,
      ref: Type.Optional(Type.String({ description: "Element ref from chrome_snapshot to clip to." })),
      selector: Type.Optional(Type.String({ description: "CSS selector to clip to." })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture beyond the viewport when possible." }))
    }),
    async execute(_toolCallId, params = {}, signal) {
      if (bridgeEnabled()) return saveBridgeScreenshot(params, signal);
      return saveScreenshot(params, signal);
    }
  });

  pi.registerTool({
    name: "chrome_evaluate",
    label: "Evaluate in Chrome",
    description: "Evaluate a JavaScript expression in a Chrome tab and return the JSON-serializable result. Use for reading page state that other tools do not expose.",
    promptGuidelines: [
      "Do not run code that submits forms, changes accounts, makes purchases, or performs destructive actions unless the user explicitly requested it.",
      "Prefer the dedicated tools (click, type, snapshot) for interaction."
    ],
    parameters: Type.Object({
      ...TAB_LOCATOR_PARAMS,
      expression: Type.String({ description: "JavaScript expression to evaluate in the page." }),
      awaitPromise: Type.Optional(Type.Boolean({ description: "Await a returned promise before returning its resolved value." }))
    }),
    async execute(_toolCallId, params = {}, signal) {
      if (bridgeEnabled()) {
        const result = await callBridge("evaluate", params, signal);
        const value = result.value;
        return toolText(stringifyValue(value) ?? "undefined", { ...result, value, takeover: true });
      }
      return withCdp(params, signal, async (client, target) => {
        const value = await runtimeEval(client, `(() => { const __r = (${params.expression}); return __r; })()`, Boolean(params.awaitPromise));
        let text;
        try {
          text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        } catch {
          text = String(value);
        }
        return toolText(text ?? "undefined", { tabId: target.id, value });
      });
    }
  });
}
