import { expect } from "@playwright/test";
import { _electron as electron, type CDPSession, type ElectronApplication, type Locator, type Page } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_USER_DATA_DIR_COMPONENT_MAX_BYTES, e2eUserDataDirName } from "./userDataDir.mjs";

export { E2E_USER_DATA_DIR_COMPONENT_MAX_BYTES, e2eUserDataDirName } from "./userDataDir.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const rootDir = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (filename: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): Record<string, unknown> | undefined; all(...params: unknown[]): Array<Record<string, unknown>> };
    close(): void;
  };
};

export type HarnessApp = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
};

export function seedLegacyDeepSeekContentProjection(userDataDir: string): string {
  const db = new DatabaseSync(path.join(userDataDir, "data", "jasmine.sqlite"));
  try {
    const row = db.prepare(`
      SELECT id, thread_id, session_entry_id FROM chat_messages
      WHERE role = 'assistant'
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get();
    if (!row?.id || !row.thread_id || !row.session_entry_id) throw new Error("Assistant fixture row is unavailable.");
    const timeline = [
      {
        id: "e2e-context-taxonomy",
        kind: "system",
        title: "Context taxonomy",
        text: "captured",
        customType: "context-taxonomy",
        data: {
          items: [{ kind: "provider_options", text: JSON.stringify({ thinking: { type: "enabled" }, reasoning_effort: "high" }) }]
        }
      },
      { id: "deepseek-thinking-level-repair", kind: "system", title: "Thinking level", text: "high" },
      { id: "e2e-thinking-level", kind: "system", title: "Thinking level", text: "high" },
      { id: `${row.session_entry_id}-0`, kind: "thinking", text: "Mock reply from Jasmine." },
      { id: "e2e-tool-call", kind: "tool_call", toolName: "read", title: "read", argumentsJson: JSON.stringify({ path: "AGENTS.md" }) },
      { id: "e2e-tool-result", kind: "tool_result", toolName: "read", title: "read", content: "Project instructions loaded." },
      { id: "e2e-final-answer", kind: "assistant_text", text: "Visible final answer." }
    ];
    db.prepare(`
      UPDATE chat_messages
      SET content = ?, elapsed_ms = 229000, model_id = 'deepseek-v4-flash', timeline_json = ?
      WHERE id = ?
    `).run(
      "Visible final answer.",
      JSON.stringify(timeline),
      row.id
    );
    db.prepare("DELETE FROM schema_migrations WHERE version = 29").run();
    return String(row.thread_id);
  } finally {
    db.close();
  }
}

export async function readThreadPiSession(userDataDir: string, threadId: string): Promise<{
  sessionId: string;
  sessionFile: string;
  formatVersion: number;
  messageEntryIds: string[];
  entries: Array<Record<string, unknown>>;
}> {
  const db = new DatabaseSync(path.join(userDataDir, "data", "jasmine.sqlite"), { readOnly: true });
  try {
    const thread = db.prepare(`
      SELECT session_id, session_file, session_format_version
      FROM chat_threads WHERE id = ?
    `).get(threadId);
    if (!thread?.session_id || !thread.session_file) throw new Error(`Thread ${threadId} has no Pi session binding.`);
    const messageEntryIds = db.prepare(`
      SELECT session_entry_id FROM chat_messages
      WHERE thread_id = ? ORDER BY created_at, id
    `).all(threadId).map((row) => String(row.session_entry_id ?? ""));
    const sessionFile = String(thread.session_file);
    const entries = (await readFile(sessionFile, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return {
      sessionId: String(thread.session_id),
      sessionFile,
      formatVersion: Number(thread.session_format_version),
      messageEntryIds,
      entries
    };
  } finally {
    db.close();
  }
}

export async function seedThreadPiContextUsage(
  userDataDir: string,
  threadId: string,
  totalTokens: number
): Promise<void> {
  const cwd = path.join(userDataDir, "scratch", "chats");
  const sessionDir = path.join(userDataDir, "pi-agent", "sessions", "--e2e-context--");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const manager = SessionManager.create(cwd, sessionDir, { id: threadId });
  manager.appendMessage({ role: "user", content: "context fixture prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "context fixture response" }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  });
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Context fixture session did not persist.");

  const db = new DatabaseSync(path.join(userDataDir, "data", "jasmine.sqlite"));
  try {
    db.prepare(`
      UPDATE chat_threads
      SET session_id = ?, session_file = ?, session_format_version = 3
      WHERE id = ?
    `).run(manager.getSessionId(), sessionFile, threadId);
  } finally {
    db.close();
  }
}

export function appendThreadPiCompaction(userDataDir: string, threadId: string): void {
  const db = new DatabaseSync(path.join(userDataDir, "data", "jasmine.sqlite"), { readOnly: true });
  let sessionFile = "";
  try {
    const row = db.prepare("SELECT session_file FROM chat_threads WHERE id = ?").get(threadId);
    sessionFile = String(row?.session_file ?? "");
  } finally {
    db.close();
  }
  if (!sessionFile) throw new Error("Context fixture session binding is unavailable.");
  const manager = SessionManager.open(sessionFile, path.dirname(sessionFile));
  const firstEntry = manager.getBranch()[0];
  if (!firstEntry) throw new Error("Context fixture session is empty.");
  manager.appendCompaction("context fixture summary", firstEntry.id, 420);
}

export async function expectComposerDraft(page: Page, expected: string): Promise<void> {
  await expectComposerEditorText(page.locator(".rich-composer-editor"), expected);
}

export async function expectComposerEditorText(editor: Locator, expected: string): Promise<void> {
  await expect.poll(() => editor.evaluate((node) => (((node as HTMLElement).innerText || node.textContent || "").replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").replace(/\n$/, "")))).toBe(expected);
}

/**
 * Waits until the composer's DOM and caret stop moving.
 *
 * Draft assertions pass the moment the text matches, which for a cleared editor
 * is before Lexical has finished rebuilding the empty paragraph and placing the
 * caret in it. Text written in that gap lands in a node the reconciler is about
 * to replace and disappears with it, so anything that writes into a just-cleared
 * composer has to wait for this first.
 */
export async function waitForComposerSettled(page: Page): Promise<void> {
  await expect.poll(async () => page.locator(".rich-composer-editor").evaluate(async (node) => {
    const read = () => {
      const selection = window.getSelection();
      return JSON.stringify({
        html: node.innerHTML,
        offset: selection?.anchorOffset ?? null,
        inEditor: selection?.anchorNode ? node.contains(selection.anchorNode) : false
      });
    };
    const before = read();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    return before === read();
  })).toBe(true);
}

/**
 * Types `text` through the browser's own IME, leaving it uncommitted so the run
 * observes what the composer does mid-composition. Commit it with
 * {@link commitImeComposition}.
 *
 * Dispatching CompositionEvent by hand instead races Lexical: the editor listens
 * for those events too, so a hand-made compositionstart convinces it an IME owns
 * the DOM, and the text a subsequent insertText writes is then reconciled away
 * about half the time, leaving only its placeholder zero-width spaces behind.
 */
export async function startImeComposition(app: ElectronApplication, page: Page, text: string): Promise<CDPSession> {
  const cdp = await app.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  return cdp;
}

export async function commitImeComposition(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

export async function expectExecutablePathMetadata(output: Locator): Promise<void> {
  // Pixel polish (no top border, compact single-line height) is covered by the visual harness;
  // here we only assert the metadata output is present and renders non-empty text.
  await expect(output).toBeVisible();
  await expect(output).not.toBeEmpty();
}

export async function startEmptyThread(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New chat" }).first().click();
  await expect(page.locator(".empty-state")).toBeVisible();
  await expect(page.locator(".user-bubble")).toHaveCount(0);
}

export async function waitForStableAssistant(page: Page, text: string, timeout = 10_000): Promise<Locator> {
  const assistant = page.locator(".assistant-block:not(.live-message)").last();
  await expect(assistant).toContainText(text, { timeout });
  await expect(page.locator(".assistant-block.live-message")).toHaveCount(0, { timeout });
  return assistant;
}

export async function openMemoryFromCommandPalette(page: Page): Promise<void> {
  await page.keyboard.press("Control+K");
  await expect(page.locator(".command-panel")).toBeVisible();
  await page.locator(".command-panel").getByRole("button", { name: "Memory" }).click();
  await expect(page.locator(".memory-panel")).toBeVisible();
}

export async function openSettings(page: Page, section?: string): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.locator(".side-menu").getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".settings-panel")).toBeVisible();
  if (section) {
    await page.locator(".settings-nav").getByRole("button", { name: section }).click();
  }
}

export async function expectSettingsSaved(page: Page): Promise<void> {
  const state = page.locator(".settings-detail .save-state");
  await expect(state).toHaveClass(/saved/);
  await expect(state).toHaveText(/^(Saved|已保存)$/);
}

export async function saveSettings(page: Page): Promise<void> {
  await page.locator(".settings-detail").getByRole("button", { name: "Save" }).click();
  await expectSettingsSaved(page);
}

export async function openProviderSettings(page: Page): Promise<void> {
  await openSettings(page, "Providers");
}

export async function saveProvider(page: Page): Promise<void> {
  await page.locator(".settings-actions button.primary").click();
  await expect(page.locator(".save-state")).toHaveText("Saved");
}

export async function testProvider(page: Page): Promise<void> {
  await page.locator(".settings-actions").getByRole("button", { name: "Test" }).click();
  await expect(page.locator(".provider-status")).toHaveText("Connected");
}

export async function expectNoPurpleThemeColors(locator: Locator, label: string): Promise<void> {
  const offenders = await locator.evaluate((root) => {
    const colorProperties = [
      "color",
      "backgroundColor",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
      "outlineColor",
      "textDecorationColor",
      "caretColor"
    ] as const;
    const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];

    function parseRgb(value: string): { r: number; g: number; b: number; a: number } | null {
      const match = value.match(/^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*(\d+(?:\.\d+)?))?\)$/);
      if (!match) return null;
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4])
      };
    }

    function isPurpleLike(color: { r: number; g: number; b: number; a: number }): boolean {
      if (color.a < 0.05) return false;
      const r = color.r / 255;
      const g = color.g / 255;
      const b = color.b / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      if (delta < 0.14) return false;
      let hue = 0;
      if (max === r) hue = ((g - b) / delta) % 6;
      if (max === g) hue = (b - r) / delta + 2;
      if (max === b) hue = (r - g) / delta + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
      const lightness = (max + min) / 2;
      const saturation = delta / (1 - Math.abs(2 * lightness - 1));
      return hue >= 250 && hue <= 310 && saturation > 0.24;
    }

    return elements.flatMap((element) => {
      const styles = getComputedStyle(element);
      return colorProperties.flatMap((property) => {
        const parsed = parseRgb(styles[property]);
        if (!parsed || !isPurpleLike(parsed)) return [];
        const name = element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 48) || element.className || element.tagName;
        return [`${name}: ${property}=${styles[property]}`];
      });
    });
  });
  expect(offenders, `${label} should use codex-theme blue/neutral colors, not purple/violet`).toEqual([]);
}

export async function clickCenter(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  await locator.page().mouse.click((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
}

// macOS keeps native traffic lights, so there is no role-addressable Close
// button to click there (see WindowControls.tsx). Drive the same IPC the button
// invokes instead, so tray/close coverage stays identical on every platform.
export async function closeWindowFromTitleBar(page: Page): Promise<void> {
  if (process.platform === "darwin") {
    await page.evaluate(() => window.jasmine.windowAction("close"));
    return;
  }
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

export async function modelMenuGeometry(page: Page) {
  return page.evaluate(() => {
    const trigger = document.querySelector(".model-pill")?.getBoundingClientRect();
    const menu = document.querySelector(".model-menu")?.getBoundingClientRect();
    if (!trigger || !menu) throw new Error("Model menu or trigger is missing.");
    return {
      triggerLeft: trigger.left,
      triggerRight: trigger.right,
      triggerTop: trigger.top,
      triggerBottom: trigger.bottom,
      menuLeft: menu.left,
      menuTop: menu.top,
      menuRight: menu.right,
      menuBottom: menu.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  });
}

export function expectModelMenuAnchored(geometry: Awaited<ReturnType<typeof modelMenuGeometry>>): void {
  const overlapsTrigger = geometry.menuRight > geometry.triggerLeft && geometry.menuLeft < geometry.triggerRight;
  expect(overlapsTrigger).toBe(true);
  if (geometry.menuTop < geometry.triggerTop) {
    expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.triggerTop + 10);
  } else {
    expect(geometry.menuTop).toBeGreaterThanOrEqual(geometry.triggerBottom - 10);
  }
}

export async function expectToolbarHasNoOverlap(page: Page): Promise<void> {
  const result = await page.locator(".composer").evaluate((composer) => {
    const composerBox = composer.getBoundingClientRect();
    const items = Array.from(composer.querySelectorAll<HTMLElement>(".composer-bar > *"))
      .filter((item) => {
        const box = item.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(item).visibility !== "hidden";
      })
      .map((item) => {
        const box = item.getBoundingClientRect();
        return {
          label: item.getAttribute("aria-label") || item.textContent?.trim() || item.className,
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom
        };
      });
    const overlaps: string[] = [];
    for (let index = 0; index < items.length; index += 1) {
      for (let next = index + 1; next < items.length; next += 1) {
        const a = items[index];
        const b = items[next];
        const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapWidth > 1 && overlapHeight > 1) overlaps.push(`${a.label} overlaps ${b.label}`);
      }
    }
    return {
      overlaps,
      itemsInsideComposer: items.every((item) =>
        item.left >= composerBox.left - 1 &&
        item.right <= composerBox.right + 1 &&
        item.top >= composerBox.top - 1 &&
        item.bottom <= composerBox.bottom + 1
      )
    };
  });
  expect(result.overlaps).toEqual([]);
  expect(result.itemsInsideComposer).toBe(true);
}

/**
 * Guards the collapsed-sidebar toolbar against the defect that made its restore
 * control unclickable on macOS: it sat under `.window-drag-region`, and Electron
 * builds the native draggable region by walking the layout tree in order,
 * unioning `drag` rects and subtracting `no-drag` ones. A drag rect emitted
 * after an overlapping no-drag control covers that control back up, and the OS
 * turns every click on it into a window drag.
 *
 * Playwright clicks are injected through CDP, below the native hit test, so they
 * land on the button either way — asserting the click works cannot catch this.
 * Assert the DOM invariant the native region math depends on instead.
 */
export async function expectCollapsedSidebarChrome(page: Page, railRowCenterY: number): Promise<void> {
  // The toolbar slides in from the rail's edge, and a transform moves the rects
  // below. Settle it before measuring rather than racing a 140ms animation.
  await page.locator(".sidebar-restore-bar").evaluate(async (bar) => {
    await Promise.all(bar.getAnimations().map((animation) => animation.finished));
  });
  const result = await page.evaluate(() => {
    const bar = document.querySelector(".sidebar-restore-bar");
    if (!(bar instanceof HTMLElement)) throw new Error("Collapsed sidebar toolbar is missing.");
    const barBox = bar.getBoundingClientRect();
    const dragRegions: string[] = [];
    const coveredBy: string[] = [];
    for (const node of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      if (getComputedStyle(node).getPropertyValue("-webkit-app-region").trim() !== "drag") continue;
      const name = node.className || node.tagName;
      dragRegions.push(name);
      const box = node.getBoundingClientRect();
      const overlaps = box.left < barBox.right && box.right > barBox.left &&
        box.top < barBox.bottom && box.bottom > barBox.top;
      if (!overlaps) continue;
      if (bar.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) coveredBy.push(name);
    }
    const insetLeft = getComputedStyle(document.documentElement).getPropertyValue("--titlebar-inset-left");
    return {
      barVisible: barBox.width > 0 && barBox.height > 0,
      centerY: barBox.top + barBox.height / 2,
      left: barBox.left,
      insetLeft: Number.parseFloat(insetLeft) || 0,
      dragRegions,
      coveredBy
    };
  });
  expect(result.barVisible).toBe(true);
  // A build where `-webkit-app-region` stops reaching computed style would make
  // the drag-order assertion vacuous, so prove the walk saw the shell's strips.
  expect(result.dragRegions.length).toBeGreaterThan(0);
  expect(result.coveredBy).toEqual([]);
  // Collapsing slides the rail's icon row left; it must not also lift it off
  // the title-bar midline the macOS traffic lights sit on.
  expect(Math.abs(result.centerY - railRowCenterY)).toBeLessThanOrEqual(2);
  // And it must stay clear of whatever the platform reserves on the left.
  expect(result.left).toBeGreaterThanOrEqual(result.insetLeft);
}

export async function stableChatLayoutSnapshot(page: Page): Promise<{ composerTop: number; messageScrollBottom: number; scrollTop: number }> {
  return page.evaluate(() => {
    const composer = document.querySelector(".composer");
    const scroll = document.querySelector(".message-scroll");
    if (!(composer instanceof HTMLElement) || !(scroll instanceof HTMLElement)) {
      throw new Error("Chat layout elements are missing.");
    }
    return {
      composerTop: Math.round(composer.getBoundingClientRect().top),
      messageScrollBottom: Math.round(scroll.getBoundingClientRect().bottom),
      scrollTop: Math.round(scroll.scrollTop)
    };
  });
}

export async function expectFloatingMenuInViewport(page: Page, menuSelector: string, triggerSelector: string): Promise<void> {
  const result = await page.evaluate(({ menuSelector, triggerSelector }) => {
    const menu = document.querySelector(menuSelector)?.getBoundingClientRect();
    const trigger = document.querySelector(triggerSelector)?.getBoundingClientRect();
    if (!menu || !trigger) throw new Error("Floating menu or trigger is missing.");
    return {
      menuLeft: menu.left,
      menuTop: menu.top,
      menuRight: menu.right,
      menuBottom: menu.bottom,
      triggerLeft: trigger.left,
      triggerRight: trigger.right,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  }, { menuSelector, triggerSelector });

  expect(result.menuLeft).toBeGreaterThanOrEqual(6);
  expect(result.menuTop).toBeGreaterThanOrEqual(6);
  expect(result.menuRight).toBeLessThanOrEqual(result.viewportWidth - 6);
  expect(result.menuBottom).toBeLessThanOrEqual(result.viewportHeight - 6);
  expect(result.menuRight).toBeGreaterThan(result.triggerLeft);
  expect(result.menuLeft).toBeLessThan(result.triggerRight);
}

export async function expectSurfaceInViewport(page: Page, selector: string): Promise<void> {
  const result = await page.evaluate((selector) => {
    const surface = document.querySelector(selector)?.getBoundingClientRect();
    if (!surface) throw new Error("Floating surface is missing.");
    return {
      left: surface.left,
      top: surface.top,
      right: surface.right,
      bottom: surface.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  }, selector);

  expect(result.left).toBeGreaterThanOrEqual(4);
  expect(result.top).toBeGreaterThanOrEqual(4);
  expect(result.right).toBeLessThanOrEqual(result.viewportWidth - 4);
  expect(result.bottom).toBeLessThanOrEqual(result.viewportHeight - 4);
}

export async function expectEmptyChatClearOfRightPanel(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const panel = document.querySelector(".chat-right-panel")?.getBoundingClientRect();
    const chatPage = document.querySelector(".chat-page")?.getBoundingClientRect();
    const title = document.querySelector(".empty-state h1")?.getBoundingClientRect();
    const emptyState = document.querySelector(".empty-state")?.getBoundingClientRect();
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    if (!panel || !chatPage || !title || !emptyState || !composer) throw new Error("Empty chat layout or right panel is missing.");
    return {
      panelLeft: panel.left,
      titleRight: title.right,
      emptyStateCenter: emptyState.left + emptyState.width / 2,
      composerRight: composer.right,
      composerCenter: composer.left + composer.width / 2,
      contentCenter: chatPage.left + (panel.left - chatPage.left) / 2
    };
  });

  expect(result.titleRight).toBeLessThanOrEqual(result.panelLeft - 20);
  expect(result.composerRight).toBeLessThanOrEqual(result.panelLeft - 20);
  expect(Math.abs(result.emptyStateCenter - result.contentCenter)).toBeLessThanOrEqual(16);
  expect(Math.abs(result.composerCenter - result.contentCenter)).toBeLessThanOrEqual(16);
}

export async function messageJumpMarkAlignment(page: Page): Promise<{ maxDelta: number; monotonic: boolean }> {
  return page.locator(".message-jump-marks").evaluate((rail) => {
    const scroll = document.querySelector(".message-scroll");
    if (!(scroll instanceof HTMLElement)) throw new Error("Message scroll missing.");
    const railRect = rail.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const entries = Array.from(document.querySelectorAll<HTMLElement>(".user-message-wrap"))
      .slice(0, 6)
      .map((message) => {
        const id = message.dataset.messageId ?? "";
        const mark = rail.querySelector<HTMLElement>(`[data-message-jump-id="${CSS.escape(id)}"]`);
        const rect = message.getBoundingClientRect();
        const topInContent = rect.top - scrollRect.top + scroll.scrollTop;
        const expected = Math.min(Math.max((topInContent / Math.max(scroll.scrollHeight, 1)) * railRect.height, 4), Math.max(4, railRect.height - 4));
        return {
          actual: Number.parseFloat(mark?.style.top ?? "NaN"),
          expected
        };
      });
    return {
      maxDelta: Math.max(...entries.map((entry) => Math.abs(entry.actual - entry.expected))),
      monotonic: entries.every((entry, index) => index === 0 || entry.actual >= entries[index - 1].actual)
    };
  });
}

export function seedLargeThreadMessages(userDataDir: string, threadId: string, count: number, withExpandableThinking = false): void {
  const dbPath = path.join(userDataDir, "data", "jasmine.sqlite");
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare(`
    INSERT INTO chat_messages (
      id,
      thread_id,
      role,
      content,
      attachments_json,
      created_at,
      elapsed_ms,
      model_id,
      status,
      memory_used_json,
      skills_used_json,
      web_search_used_json,
      timeline_json
    )
    VALUES (?, ?, ?, ?, '[]', ?, ?, ?, 'sent', '[]', '[]', '[]', ?)
  `);
  // Seeding bypasses the repository layer, so the denormalized
  // chat_threads.message_count must be maintained here as well.
  const updateThread = db.prepare("UPDATE chat_threads SET updated_at = ?, message_count = message_count + ? WHERE id = ?");
  try {
    for (let index = 0; index < count; index += 1) {
      const role = index % 2 === 0 ? "user" : "assistant";
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      const content = `large import message ${index + 1} ${"x".repeat(180)}`;
      const timeline = role === "assistant"
        ? JSON.stringify([
            { id: `large-model-${index}`, kind: "system", title: "Model", text: "mock/deepseek-v4-flash" },
            ...(withExpandableThinking && index === 1 ? [{
              id: `large-thinking-${index}`,
              kind: "thinking",
              text: Array.from({ length: 18 }, (_entry, line) => `Detailed reasoning line ${line + 1} ${"y".repeat(80)}`).join("\n\n")
            }] : []),
            { id: `large-output-${index}`, kind: "assistant_text", text: content }
          ])
        : "[]";
      insert.run(
        `large-${index.toString().padStart(4, "0")}`,
        threadId,
        role,
        content,
        createdAt,
        role === "assistant" ? 10 : null,
        role === "assistant" ? "deepseek-v4-flash" : null,
        timeline
      );
    }
    updateThread.run(new Date(Date.UTC(2026, 0, 1, 0, 0, count)).toISOString(), count, threadId);
  } finally {
    db.close();
  }
}

export function updateSeededMessageContent(userDataDir: string, messageId: string, content: string): void {
  const dbPath = path.join(userDataDir, "data", "jasmine.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run(content, messageId);
  } finally {
    db.close();
  }
}

export function seedMarkdownThreadMessages(userDataDir: string, threadId: string, count: number): void {
  const dbPath = path.join(userDataDir, "data", "jasmine.sqlite");
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare(`
    INSERT INTO chat_messages (
      id,
      thread_id,
      role,
      content,
      attachments_json,
      created_at,
      elapsed_ms,
      model_id,
      status,
      memory_used_json,
      skills_used_json,
      web_search_used_json,
      timeline_json
    )
    VALUES (?, ?, ?, ?, '[]', ?, ?, ?, 'sent', '[]', '[]', '[]', ?)
  `);
  // Seeding bypasses the repository layer, so the denormalized
  // chat_threads.message_count must be maintained here as well.
  const updateThread = db.prepare("UPDATE chat_threads SET updated_at = ?, message_count = message_count + ? WHERE id = ?");
  try {
    for (let index = 0; index < count; index += 1) {
      const role = index % 2 === 0 ? "user" : "assistant";
      const createdAt = new Date(Date.UTC(2026, 0, 1, 1, 0, index)).toISOString();
      const content = role === "assistant"
        ? [
            `### Markdown answer ${index + 1}`,
            "",
            "- First point with **bold** text",
            "- Second point with `inline code`",
            "",
            "```ts",
            `const stableMarkdown${index} = \"no draft repaint\";`,
            "```"
          ].join("\n")
        : `markdown user prompt ${index + 1}`;
      const timeline = role === "assistant"
        ? JSON.stringify([
            { id: `markdown-model-${index}`, kind: "system", title: "Model", text: "mock/deepseek-v4-flash" },
            { id: `markdown-output-${index}`, kind: "assistant_text", text: content }
          ])
        : "[]";
      insert.run(
        `markdown-${index.toString().padStart(4, "0")}`,
        threadId,
        role,
        content,
        createdAt,
        role === "assistant" ? 10 : null,
        role === "assistant" ? "deepseek-v4-flash" : null,
        timeline
      );
    }
    updateThread.run(new Date(Date.UTC(2026, 0, 1, 1, 0, count)).toISOString(), count, threadId);
  } finally {
    db.close();
  }
}

export function resolveElectronExecutable(): string {
  const dist = path.join(rootDir, "node_modules", "electron", "dist");
  // macOS ships the binary inside an .app bundle rather than beside dist/.
  if (process.platform === "darwin") {
    return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  }
  return path.join(dist, process.platform === "win32" ? "electron.exe" : "electron");
}

export async function quitElectron(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ app }) => {
    app.quit();
  }).catch(() => undefined);
  await electronApp.close().catch(() => undefined);
}

type ExecutableFixture = { label: string; command: string };

// Discovery hands the first candidate straight to node-pty as the auto-detected
// shell, so a path that does not exist reproduces the posix_spawnp failure this
// fixture exists to avoid. POSIX hosts vary too much to hardcode -- zsh is the
// macOS default but is absent from most Linux installs, and slim images ship
// only /bin/sh -- so keep the preference order but take what is actually there.
function presentFixtures(kind: string, candidates: ExecutableFixture[]): ExecutableFixture[] {
  const present = candidates.filter((candidate) => existsSync(candidate.command));
  if (present.length < 2) {
    throw new Error(
      `E2E needs two ${kind} candidates that exist on this host; only ${present.length} of ` +
      `${candidates.map((candidate) => candidate.command).join(", ")} were found.`
    );
  }
  return present.slice(0, 2);
}

// The executable pickers are seeded with fixed candidates so discovery never
// depends on what happens to be installed.
export const executableFixtures = process.platform === "win32"
  ? (() => {
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      return {
        editors: [
          { label: "VS Code", command: process.execPath },
          { label: "Notepad", command: path.join(systemRoot, "System32", "notepad.exe") }
        ],
        terminals: [
          { label: "PowerShell", command: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") },
          { label: "Command Prompt", command: process.env.ComSpec || path.join(systemRoot, "System32", "cmd.exe") }
        ]
      };
    })()
  : {
      editors: presentFixtures("editor", [
        { label: "VS Code", command: process.execPath },
        { label: "Vi", command: "/usr/bin/vi" },
        { label: "Vim", command: "/usr/bin/vim" },
        { label: "Nano", command: "/usr/bin/nano" }
      ]),
      terminals: presentFixtures("terminal shell", [
        { label: "Zsh", command: "/bin/zsh" },
        { label: "Bash", command: "/bin/bash" },
        { label: "Sh", command: "/bin/sh" }
      ])
    };

export function baseLaunchEnv(userDataDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    JASMINE_E2E_USER_DATA_DIR: userDataDir,
    JASMINE_E2E_MOCK_AI: "1",
    DEEPSEEK_API_KEY: "e2e-mock-key",
    KIMI_API_KEY: "e2e-mock-key",
    ...extra
  };
}

export async function launchJasmine(label: string, existingUserDataDir?: string, extraEnv: Record<string, string> = {}): Promise<HarnessApp> {
  const userDataDir = existingUserDataDir ?? path.join(rootDir, ".tmp", "e2e", e2eUserDataDirName(label));
  if (!existingUserDataDir) await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });
  const redSquarePath = await createRedSquarePng(userDataDir);
  const projectFolderPath = await createProjectFolderFixture(userDataDir);
  const editorCandidates = JSON.stringify(executableFixtures.editors);
  const terminalCandidates = JSON.stringify(executableFixtures.terminals);

  const executablePath = resolveElectronExecutable();

  const app = await electron.launch({
    executablePath,
    args: [".", "--disable-gpu"],
    cwd: rootDir,
    env: baseLaunchEnv(userDataDir, {
      JASMINE_E2E_HARNESS: "1",
      JASMINE_E2E_MANY_MODELS: "1",
      JASMINE_E2E_PICK_FILE: redSquarePath,
      JASMINE_E2E_PICK_PROJECT_FOLDER: projectFolderPath,
      JASMINE_E2E_PICK_FOLDER: path.join(userDataDir, "plugin-fixtures", "jasmine-e2e-plugin"),
      JASMINE_E2E_PICK_SKILL_FOLDERS: path.join(userDataDir, "custom-skills"),
      JASMINE_E2E_PICK_PROMPT_TEMPLATE_PATHS: path.join(userDataDir, "prompt-templates"),
      JASMINE_E2E_OPEN_EXPLORER_LOG: path.join(userDataDir, "explorer-open.log"),
      JASMINE_E2E_PICK_EDITOR: process.execPath,
      JASMINE_E2E_PICK_TERMINAL_SHELL: process.execPath,
      JASMINE_E2E_EDITOR_CANDIDATES: editorCandidates,
      JASMINE_E2E_TERMINAL_CANDIDATES: terminalCandidates,
      JASMINE_E2E_EDITOR_PATH: process.execPath,
      JASMINE_E2E_OPEN_EDITOR_LOG: path.join(userDataDir, "editor-open.log"),
      ...extraEnv
    })
  });

  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell");
  return { app, page, userDataDir };
}

export function waitForChildExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Repeated Jasmine launch did not exit after handing off to the first instance."));
    }, 8_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function waitForAppShellPage(app: ElectronApplication, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (await candidate.locator(".app-shell").count()) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Jasmine did not navigate from the startup screen to the app shell.");
}

export async function createProjectFolderFixture(userDataDir: string): Promise<string> {
  const root = path.join(userDataDir, "local-project");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "project-note.txt"), "Project scoped file mention fixture.");
  return root;
}

export async function createRedSquarePng(dir: string): Promise<string> {
  const imagePath = path.join(dir, "red-square.png");
  await writeFile(imagePath, Buffer.from(RED_SQUARE_BASE64, "base64"));
  return imagePath;
}

export async function createExternalSkillFixture(userDataDir: string): Promise<string> {
  const root = path.join(userDataDir, "custom-skills");
  const valid = path.join(root, "ui-ux-product-harness");
  const systemIgnored = path.join(root, ".system", "ignored-system-skill");
  const mismatched = path.join(root, "mismatched-skill-name");
  await mkdir(valid, { recursive: true });
  await mkdir(systemIgnored, { recursive: true });
  await mkdir(mismatched, { recursive: true });
  await writeFile(path.join(valid, "SKILL.md"), [
    "---",
    "name: ui-ux-product-harness",
    "description: Build or run a productized UI/UX self-testing harness.",
    "---",
    "",
    "# UI/UX Product Harness",
    "",
    "Use this external skill from a custom path."
  ].join("\n"));
  await writeFile(path.join(systemIgnored, "SKILL.md"), [
    "---",
    "name: ignored-system-skill",
    "description: This skill should be skipped because it is under .system.",
    "---",
    "",
    "Do not load."
  ].join("\n"));
  await writeFile(path.join(mismatched, "SKILL.md"), [
    "---",
    "name: another-name",
    "description: This skill should be skipped because the name does not match the folder.",
    "---",
    "",
    "Do not load."
  ].join("\n"));
  return root;
}

export async function createPromptTemplateFixture(userDataDir: string): Promise<string> {
  const root = path.join(userDataDir, "prompt-templates");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "triage.md"), [
    "---",
    "description: Triage an issue with concise next actions",
    "argument-hint: <issue>",
    "---",
    "Triage $ARGUMENTS and list the next action."
  ].join("\n"));
  return root;
}

export async function createPiPluginFixture(userDataDir: string): Promise<string> {
  const packageDir = path.join(userDataDir, "plugin-fixtures", "jasmine-e2e-plugin");
  await mkdir(path.join(packageDir, "skills", "jasmine-e2e"), { recursive: true });
  await writeFile(path.join(packageDir, "package.json"), JSON.stringify({
    name: "jasmine-e2e-plugin",
    version: "1.0.0",
    type: "module",
    pi: {
      extensions: ["./extension.js"],
      skills: ["./skills"]
    }
  }, null, 2));
  await writeFile(path.join(packageDir, "extension.js"), [
    "import { Type } from '@earendil-works/pi-ai';",
    "export default function jasmineE2ePlugin(pi) {",
    "  pi.registerTool({",
    "    name: 'jasmine_e2e_tool',",
    "    label: 'Jasmine E2E tool',",
    "    description: 'E2E fixture tool from a Pi package.',",
    "    parameters: Type.Object({}),",
    "    async execute() { return { content: [{ type: 'text', text: 'ok' }] }; }",
    "  });",
    "}"
  ].join("\n"));
  await writeFile(path.join(packageDir, "skills", "jasmine-e2e", "SKILL.md"), [
    "---",
    "name: jasmine-e2e",
    "description: E2E fixture skill from a Pi package.",
    "---",
    "",
    "# Jasmine E2E",
    "",
    "Use this only for plugin settings tests."
  ].join("\n"));
  return packageDir;
}

export async function seedPiAgentPackageSettings(userDataDir: string, packages: unknown[]): Promise<void> {
  const agentDir = path.join(userDataDir, "pi-agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages }, null, 2));
}

export async function navigationPath(page: Page): Promise<string> {
  return page.evaluate(() => (window as Window & {
    __jasmineHarness?: { snapshot(): { app: { navigation: { path: string } } } };
  }).__jasmineHarness?.snapshot().app.navigation.path ?? "");
}

export const RED_SQUARE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGElEQVR4nGP8z8Dwn4ECwESJ5lEDRgAAUOQCH2mP8toAAAAASUVORK5CYII=";
