// Jasmine Chrome Control background service worker.
//
// Connects to the Jasmine native messaging host and executes a small command
// protocol against the user's real tabs via chrome.debugger (Chrome DevTools
// Protocol), so actions run with the user's existing logged-in session. Each
// request is { id, method, params }; each reply is { id, ok, result|error }.

const HOST_NAME = "com.jasmine.chrome";
const DEBUGGER_VERSION = "1.3";
const attached = new Set();

let port = null;

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
    items.push({ref:ref,tag:el.tagName.toLowerCase(),role:el.getAttribute("role")||el.tagName.toLowerCase(),type:el.getAttribute("type")||"",name:__jmName(el),value:("value" in el && el.value!=null)?String(el.value).slice(0,80):"",href:el.getAttribute("href")||"",disabled:Boolean(el.disabled)});
  }
  return {title:document.title,url:location.href,count:items.length,items:items};
}
function __jmSelectOption(p){
  const resolved=__jmResolve(p);
  if(!resolved.ok) return resolved;
  let el=null;
  if(p.ref){ el=document.querySelector('[data-jm-ref="'+p.ref+'"]'); }
  if(!el && p.selector){ el=document.querySelector(p.selector); }
  if(!el && p.text){
    const n=String(p.text).toLowerCase();
    el=Array.from(document.querySelectorAll("select")).find((x)=>__jmVisible(x) && __jmName(x).toLowerCase().includes(n));
  }
  if(!el || el.tagName!=="SELECT") return {ok:false,reason:"element is not a <select>"};
  const wantValue=String(p.value||"");
  const wantLabel=String(p.label||"");
  const option=Array.from(el.options).find((o)=>(wantValue && o.value===wantValue)||(wantLabel && (o.label||o.textContent||"").trim()===wantLabel));
  if(!option) return {ok:false,reason:"option not found"};
  el.value=option.value;
  el.dispatchEvent(new Event("input",{bubbles:true}));
  el.dispatchEvent(new Event("change",{bubbles:true}));
  return {ok:true,value:option.value,label:(option.label||option.textContent||"").trim(),url:location.href};
}
`;

function connectHost() {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    return;
  }
  port.onMessage.addListener(handleRequest);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectHost, 2000);
  });
}

function reply(id, ok, payload) {
  if (!port) return;
  port.postMessage(ok ? { id, ok: true, result: payload } : { id, ok: false, error: String(payload) });
}

function sendCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    });
  });
}

function attach(tabId) {
  return new Promise((resolve, reject) => {
    if (attached.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      attached.add(tabId);
      resolve();
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

async function resolveTabId(params) {
  if (typeof params.tabId === "number") return params.tabId;
  if (typeof params.tabId === "string" && params.tabId.trim()) {
    const numeric = Number(params.tabId);
    if (Number.isInteger(numeric)) return numeric;
  }
  if (typeof params.urlContains === "string" && params.urlContains.trim()) {
    const needle = params.urlContains.trim().toLowerCase();
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => String(item.url || "").toLowerCase().includes(needle));
    if (tab?.id != null) return tab.id;
    throw new Error(`No Chrome tab URL contains: ${params.urlContains}`);
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs[0]?.id != null) return tabs[0].id;
  const anyTabs = await chrome.tabs.query({});
  if (anyTabs[0]?.id != null) return anyTabs[0].id;
  throw new Error("No Chrome tab available.");
}

async function evaluate(tabId, expression, awaitPromise = false) {
  const result = await sendCommand(tabId, "Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation failed.");
  }
  return result.result?.value;
}

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

async function dispatchKey(tabId, key, modifiers = 0) {
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
  await sendCommand(tabId, "Input.dispatchKeyEvent", down);
  await sendCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function realClick(tabId, x, y) {
  await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function waitForLoad(tabId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ready = await evaluate(tabId, "document.readyState");
    if (ready === "complete") return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function clampWaitMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 10000;
  return Math.max(200, Math.min(60000, Math.floor(value)));
}

function quote(value) {
  return JSON.stringify(value ?? "");
}

function tabRecord(tab) {
  return {
    id: String(tab.id ?? ""),
    title: tab.title || "",
    url: tab.url || "",
    active: Boolean(tab.active)
  };
}

const HANDLERS = {
  async status() {
    const tabs = await chrome.tabs.query({});
    return { connected: true, tabCount: tabs.length };
  },
  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.map(tabRecord) };
  },
  async new_tab(params) {
    const tab = await chrome.tabs.create({ url: params.url || "about:blank", active: true });
    return tabRecord(tab);
  },
  async close_tab(params) {
    const tabId = await resolveTabId(params);
    await chrome.tabs.remove(tabId);
    return { tabId: String(tabId) };
  },
  async activate_tab(params) {
    const tabId = await resolveTabId(params);
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    return { tabId: String(tabId) };
  },
  async navigate(params) {
    const tabId = await resolveTabId(params);
    if (params.url) await chrome.tabs.update(tabId, { url: params.url });
    else if (params.action === "reload") await chrome.tabs.reload(tabId);
    else if (params.action === "back") { await attach(tabId); await evaluate(tabId, "history.back()"); }
    else if (params.action === "forward") { await attach(tabId); await evaluate(tabId, "history.forward()"); }
    else throw new Error("Provide a url or an action of back, forward, or reload.");
    await attach(tabId);
    const loaded = await waitForLoad(tabId, clampWaitMs(params.timeoutMs));
    const value = await evaluate(tabId, "({ url: location.href, title: document.title })");
    return { tabId: String(tabId), loaded, ...(value || {}) };
  },
  async snapshot(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
    const maxItems = Math.max(1, Math.min(200, Math.floor(params.maxItems ?? 200)));
    const snapshot = await evaluate(tabId, `(() => { ${PAGE_HELPERS}; return __jmSnapshot(${maxItems}); })()`);
    return { tabId: String(tabId), ...(snapshot || {}) };
  },
  async read_page(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
    const maxChars = Math.max(1000, Math.min(50000, Math.floor(params.maxChars ?? 50000)));
    const selector = typeof params.selector === "string" && params.selector.trim() ? params.selector.trim() : null;
    const page = await evaluate(tabId, `(() => {
      const node = ${selector ? `document.querySelector(${quote(selector)})` : "document.body"};
      const text = node ? (node.innerText || node.textContent || "").replace(/\\n{3,}/g, "\\n\\n").trim() : "";
      return { title: document.title, url: location.href, text: text.slice(0, ${maxChars}), truncated: text.length > ${maxChars} };
    })()`);
    return { tabId: String(tabId), ...(page || {}) };
  },
  async click(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
    const el = await evaluate(tabId, `(() => { ${PAGE_HELPERS}; return __jmResolve(${JSON.stringify({ ref: params.ref ?? null, selector: params.selector ?? null, text: params.text ?? null })}); })()`);
    if (!el?.ok) throw new Error(el?.reason || "Element not found.");
    await realClick(tabId, el.x, el.y);
    return { tabId: String(tabId), ...el };
  },
  async type(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
    const el = await evaluate(tabId, `(() => { ${PAGE_HELPERS}; return __jmResolve(${JSON.stringify({ ref: params.ref ?? null, selector: params.selector ?? null })}); })()`);
    if (!el?.ok) throw new Error(el?.reason || "Element not found.");
    await realClick(tabId, el.x, el.y);
    if (params.clear !== false) {
      await dispatchKey(tabId, "a", MODIFIER_BITS.Control);
      await dispatchKey(tabId, "Delete");
    }
    if (params.text) await sendCommand(tabId, "Input.insertText", { text: String(params.text) });
    if (params.submit) await dispatchKey(tabId, "Enter");
    return { tabId: String(tabId), submit: Boolean(params.submit), ...el };
  },
  async press_key(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
    await dispatchKey(tabId, params.key, modifierBits(params.modifiers ?? []));
    return { tabId: String(tabId), key: params.key };
  },
  async scroll(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
    if (params.ref || params.selector || params.text) {
      const el = await evaluate(tabId, `(() => { ${PAGE_HELPERS}; return __jmResolve(${JSON.stringify({ ref: params.ref ?? null, selector: params.selector ?? null, text: params.text ?? null })}); })()`);
      if (!el?.ok) throw new Error(el?.reason || "Element not found.");
      return { tabId: String(tabId), ...el };
    }
    const direction = ["up", "down", "left", "right"].includes(params.direction) ? params.direction : "down";
    const amount = Number.isFinite(params.amount) ? Math.floor(params.amount) : 0;
    const value = await evaluate(tabId, `(() => {
      const dir = ${quote(direction)};
      const amount = ${amount};
      const dx = dir === "left" ? -(amount || window.innerWidth) : dir === "right" ? (amount || window.innerWidth) : 0;
      const dy = dir === "up" ? -(amount || window.innerHeight) : dir === "down" ? (amount || window.innerHeight) : 0;
      window.scrollBy(dx, dy);
      return { scrollX: window.scrollX, scrollY: window.scrollY };
    })()`);
    return { tabId: String(tabId), direction, ...(value || {}) };
  },
  async hover(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
    const el = await evaluate(tabId, `(() => { ${PAGE_HELPERS}; return __jmResolve(${JSON.stringify({ ref: params.ref ?? null, selector: params.selector ?? null, text: params.text ?? null })}); })()`);
    if (!el?.ok) throw new Error(el?.reason || "Element not found.");
    await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: el.x, y: el.y, buttons: 0 });
    return { tabId: String(tabId), ...el };
  },
  async select_option(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
    const result = await evaluate(tabId, `(() => { ${PAGE_HELPERS}; return __jmSelectOption(${JSON.stringify({
      ref: params.ref ?? null,
      selector: params.selector ?? null,
      text: params.text ?? null,
      value: params.value ?? "",
      label: params.label ?? ""
    })}); })()`);
    if (!result?.ok) throw new Error(result?.reason || "Select failed.");
    return { tabId: String(tabId), ...result };
  },
  async wait_for(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
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
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const met = await evaluate(tabId, `Boolean(${condition})`);
      if (met) return { tabId: String(tabId), label, waitedMs: Date.now() - startedAt };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
  },
  async evaluate(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
    return { tabId: String(tabId), value: await evaluate(tabId, `(() => { return (${params.expression}); })()`, Boolean(params.awaitPromise)) };
  },
  async screenshot(params) {
    const tabId = await resolveTabId(params);
    await attach(tabId);
    await sendCommand(tabId, "Page.enable");
    let clip;
    if (params.ref || params.selector) {
      const element = await evaluate(tabId, `(() => { ${PAGE_HELPERS}; return __jmResolve(${JSON.stringify({ ref: params.ref ?? null, selector: params.selector ?? null, text: null })}); })()`);
      if (!element?.ok) throw new Error(element?.reason || "Element not found.");
      if (element.width > 0 && element.height > 0) {
        clip = { x: element.left, y: element.top, width: element.width, height: element.height, scale: 1 };
      }
    }
    const result = await sendCommand(tabId, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: Boolean(params.fullPage),
      ...(clip ? { clip } : {})
    });
    const tab = await chrome.tabs.get(tabId);
    return { tabId: String(tabId), title: tab.title || "", url: tab.url || "", dataBase64: result.data };
  }
};

async function handleRequest(message) {
  if (!message || typeof message.id === "undefined") return;
  const handler = HANDLERS[message.method];
  if (!handler) {
    reply(message.id, false, `Unknown method: ${message.method}`);
    return;
  }
  try {
    reply(message.id, true, await handler(message.params ?? {}));
  } catch (error) {
    reply(message.id, false, error instanceof Error ? error.message : String(error));
  }
}

connectHost();
