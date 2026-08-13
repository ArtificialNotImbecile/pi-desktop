import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  baseLaunchEnv,
  clickCenter,
  createExternalSkillFixture,
  createPiPluginFixture,
  createProjectFolderFixture,
  createPromptTemplateFixture,
  createRedSquarePng,
  expectComposerDraft,
  expectComposerEditorText,
  expectEmptyChatClearOfRightPanel,
  expectExecutablePathMetadata,
  expectFloatingMenuInViewport,
  expectModelMenuAnchored,
  expectNoPurpleThemeColors,
  expectSettingsSaved,
  expectSurfaceInViewport,
  expectToolbarHasNoOverlap,
  launchJasmine,
  messageJumpMarkAlignment,
  modelMenuGeometry,
  navigationPath,
  openMemoryFromCommandPalette,
  openProviderSettings,
  openSettings,
  quitElectron,
  resolveElectronExecutable,
  rootDir,
  saveProvider,
  saveSettings,
  seedLargeThreadMessages,
  seedMarkdownThreadMessages,
  seedPiAgentPackageSettings,
  stableChatLayoutSnapshot,
  startEmptyThread,
  testProvider,
  type HarnessApp,
  waitForAppShellPage,
  waitForChildExit,
  waitForStableAssistant
} from "./helpers";

test.describe("Jasmine panels and tools", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("explicit memories can be saved, edited, used, archived, and deleted", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("seed memory source");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");

    await page.locator(".assistant-block").last().getByRole("button", { name: "Message actions" }).click();
    await page.locator(".message-menu").getByRole("button", { name: "Remember this" }).click();
    await expect(page.locator(".memory-dialog")).toBeVisible();
    await page.getByRole("textbox", { name: "Memory content" }).fill("My preferred editor is Vim");
    await page.locator(".memory-dialog").getByRole("button", { name: "Save memory" }).click();
    await expect(page.locator(".toast")).toHaveText("Memory saved");
    await expect(page.locator(".memory-panel")).toBeVisible();
    await expect(page.locator(".memory-use-toggle")).toHaveText("Using");
    await expect(page.locator(".memory-row")).toContainText("My preferred editor is Vim");
    await expectNoPurpleThemeColors(page.locator(".memory-panel"), "memory panel");

    await page.locator(".memory-row").getByRole("button", { name: "Edit memory" }).click();
    await page.getByRole("textbox", { name: "Edit memory content" }).fill("My preferred editor is Neovim");
    await page.locator(".memory-edit").getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".memory-row")).toContainText("My preferred editor is Neovim");

    await page.locator(".rich-composer-editor").fill("memory preferred editor?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Memory-aware reply: My preferred editor is Neovim");
    await expect(page.locator(".assistant-block").last().locator(".memory-used-line")).toContainText("My preferred editor is Neovim");
    await expectNoPurpleThemeColors(page.locator(".assistant-block").last(), "memory-used message indicator");

    await openMemoryFromCommandPalette(page);
    await expect(page.locator(".memory-panel")).toBeVisible();
    await page.locator(".memory-row").getByRole("button", { name: "Archive" }).click();
    await expect(page.locator(".memory-row")).toContainText("Archived");
    await page.locator(".rich-composer-editor").fill("memory preferred editor again?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".assistant-block").last().locator(".memory-used-line")).toHaveCount(0);

    await openMemoryFromCommandPalette(page);
    await expect(page.locator(".memory-panel")).toBeVisible();
    await page.locator(".memory-row").getByRole("button", { name: "Restore" }).click();
    await page.locator(".memory-row").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".confirm-dialog")).toBeVisible();
    await page.locator(".confirm-dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".memory-row")).toHaveCount(0);
  });

  test("activity recorder shell is explicit, searchable, and never captures silently", async () => {
    const { page } = harness;

    await page.keyboard.press("Control+K");
    await page.getByRole("combobox", { name: "Command palette" }).fill("activity");
    await page.keyboard.press("Enter");
    await expect(page.locator(".activity-panel")).toBeVisible();
    await expect(page.locator(".activity-status-card")).toContainText("No background capture is running");
    await expect(page.locator(".activity-panel")).toContainText("No screenshots, raw keystrokes, browser URLs, or window titles are collected");

    const beforeEnable = await page.evaluate(async () => window.jasmine.listActivityObservations());
    expect(beforeEnable).toHaveLength(0);

    await page.locator(".activity-controls").getByRole("button", { name: "Enable recorder" }).click();
    await expect(page.locator(".activity-status-card")).toContainText("Running");
    await expect.poll(() => page.evaluate(async () => window.jasmine.listActivityObservations().then((items) => items.length))).toBe(0);

    await page.locator(".activity-controls").getByRole("button", { name: "Pause" }).click();
    await expect(page.locator(".activity-status-card")).toContainText("Paused");
    await expectNoPurpleThemeColors(page.locator(".activity-panel"), "activity panel");
    await page.locator(".activity-controls").getByRole("button", { name: "Resume" }).click();
    await expect(page.locator(".activity-status-card")).toContainText("Running");

    await page.locator(".activity-create textarea").fill("Reviewed Jasmine migration Phase 6 plan");
    await page.locator(".activity-create").getByRole("button", { name: "Add observation" }).click();
    await expect(page.locator(".toast")).toHaveText("Activity saved");
    await expect(page.locator(".activity-row")).toContainText("Reviewed Jasmine migration Phase 6 plan");

    await page.getByRole("textbox", { name: "Search activity" }).fill("Phase 6");
    await expect(page.locator(".activity-row")).toHaveCount(1);
    await page.getByRole("textbox", { name: "Search activity" }).fill("missing activity note");
    await expect(page.locator(".activity-empty")).toHaveText("No matching activity yet.");

    await page.locator(".activity-privacy label", { hasText: "Allow window titles later" }).click();
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getActivitySettings()).captureWindowTitles)).toBe(true);
    await page.locator(".activity-panel").getByRole("button", { name: "Close activity panel" }).click();
    await expect(page.locator(".activity-panel")).toBeHidden();
  });

  test("right panel terminal resizes and preserves terminal session @desktop-session", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.getByRole("button", { name: "Open Terminal" }).click();
    await expect(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
    await expectEmptyChatClearOfRightPanel(page);
    const resizeHandle = page.getByRole("separator", { name: "Resize right panel" });
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "360");
    const panelBeforeResize = await page.locator(".chat-right-panel").boundingBox();
    const handleBox = await resizeHandle.boundingBox();
    expect(panelBeforeResize).not.toBeNull();
    expect(handleBox).not.toBeNull();
    await page.mouse.click((handleBox?.x ?? 0) - 12, (handleBox?.y ?? 0) + 80);
    await expect(page.locator(".chat-right-panel")).toHaveCSS("width", "360px");
    await page.mouse.move((handleBox?.x ?? 0) + 5, (handleBox?.y ?? 0) + 80);
    await page.mouse.down();
    await page.mouse.move((handleBox?.x ?? 0) - 115, (handleBox?.y ?? 0) + 80, { steps: 8 });
    await page.mouse.up();
    const panelAfterPointerResize = await page.locator(".chat-right-panel").boundingBox();
    expect((panelAfterPointerResize?.width ?? 0) - (panelBeforeResize?.width ?? 0)).toBeGreaterThanOrEqual(100);
    await expectEmptyChatClearOfRightPanel(page);
    await resizeHandle.focus();
    const widthBeforeKeyboardResize = panelAfterPointerResize?.width ?? 0;
    await page.keyboard.press("ArrowRight");
    const panelAfterKeyboardResize = await page.locator(".chat-right-panel").boundingBox();
    expect(widthBeforeKeyboardResize - (panelAfterKeyboardResize?.width ?? 0)).toBeGreaterThanOrEqual(20);
    await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(800, 700));
    await expect.poll(async () => (await page.locator(".chat-right-panel").boundingBox())?.width ?? 0).toBeLessThanOrEqual(440);
    await expectEmptyChatClearOfRightPanel(page);
    await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1200, 800));
    await expect(page.locator(".terminal-emulator .xterm-rows")).toBeVisible();
    await page.getByLabel("Terminal command").click();
    await page.keyboard.type("echo JASMINE_TERMINAL_TEST");
    await page.keyboard.press("Enter");
    await expect(page.locator(".terminal-output")).toContainText("JASMINE_TERMINAL_TEST");
    await expect(page.locator(".terminal-output")).not.toContainText("cannot set terminal process group");
    await expect(page.locator(".terminal-output")).not.toContainText("[33m");
    await expect(page.locator(".terminal-input")).toHaveCount(0);
    const terminalSurface = page.getByLabel("Terminal command");
    await terminalSurface.click();
    await page.keyboard.press("Control+A");
    await terminalSurface.click({ button: "right" });
    const terminalMenu = page.getByRole("menu", { name: "Terminal menu" });
    await expect(terminalMenu).toBeVisible();
    await expect(terminalMenu.getByRole("menuitem", { name: /Cut/ })).toBeEnabled();
    await expect(terminalMenu.getByRole("menuitem", { name: /Copy/ })).toBeEnabled();
    await terminalMenu.getByRole("menuitem", { name: /Copy/ }).click();
    await expect.poll(() => page.evaluate(() => window.jasmine.readClipboardText())).toContain("JASMINE_TERMINAL_TEST");
    await terminalSurface.click({ button: "right" });
    await terminalMenu.getByRole("menuitem", { name: /Select All/ }).click();
    await terminalSurface.click({ button: "right" });
    await terminalMenu.getByRole("menuitem", { name: /Cut/ }).click();
    await expect.poll(() => page.evaluate(() => window.jasmine.readClipboardText())).toContain("JASMINE_TERMINAL_TEST");
    await page.evaluate(() => window.jasmine.writeClipboardText("echo JASMINE_TERMINAL_PASTE"));
    await terminalSurface.click({ button: "right" });
    await terminalMenu.getByRole("menuitem", { name: /Paste/ }).click();
    await page.keyboard.press("Enter");
    await expect(page.locator(".terminal-output")).toContainText("JASMINE_TERMINAL_PASTE");

    await page.getByRole("button", { name: "Collapse panel" }).click();
    await expect(page.locator(".chat-right-panel")).toBeHidden();
    await expect(page.locator(".chat-page")).not.toHaveClass(/right-panel-open/);
    const terminalRailButton = page.getByRole("button", { name: "Open Terminal" });
    await expect(terminalRailButton).toHaveClass(/open/);
    await expect(terminalRailButton).not.toHaveClass(/active/);
    await terminalRailButton.click();
    await expect(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
    await expect(page.locator(".chat-page")).toHaveClass(/right-panel-open/);
    await expect(page.locator(".terminal-output")).toContainText("JASMINE_TERMINAL_TEST");
    await expect(page.locator(".terminal-output")).toContainText("JASMINE_TERMINAL_PASTE");
    await terminalRailButton.click();
    await expect(page.locator(".chat-right-panel")).toBeHidden();
    await terminalRailButton.click();
    await expect(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
  });

  test("right panel artifacts and context taxonomy update from the current thread", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.getByRole("button", { name: "Open Terminal" }).click();
    await expect(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
    const addPanelButton = page.getByRole("button", { name: "Add panel" });
    const inertAddPoint = await page.evaluate(() => {
      const button = document.querySelector(".right-panel-add-tab");
      const header = document.querySelector(".chat-right-panel-header");
      if (!(button instanceof HTMLElement) || !(header instanceof HTMLElement)) throw new Error("Add panel controls are missing.");
      const buttonBox = button.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      for (let x = buttonBox.right + 4; x < headerBox.right - 34; x += 4) {
        const y = buttonBox.top + buttonBox.height / 2;
        const target = document.elementFromPoint(x, y);
        if (!(target instanceof HTMLElement) || !target.closest("button")) {
          return { x, y };
        }
      }
      throw new Error("No inert point near Add panel button was found.");
    });
    await page.mouse.click(inertAddPoint.x, inertAddPoint.y);
    await expect(page.getByRole("menu", { name: "Add panel menu" })).toBeHidden();
    await addPanelButton.click();
    const addPanelMenu = page.getByRole("menu", { name: "Add panel menu" });
    await expect(addPanelMenu).toBeVisible();
    await expect(addPanelMenu.getByRole("menuitem", { name: "Terminal" })).toBeVisible();
    await expect(addPanelMenu.getByRole("menuitem", { name: "Artifacts" })).toBeVisible();
    await expect(addPanelMenu.getByRole("menuitem", { name: "Context taxonomy" })).toBeVisible();
    await expectFloatingMenuInViewport(page, ".right-panel-add-menu", ".right-panel-add-tab");
    await page.keyboard.press("Escape");
    await expect(addPanelMenu).toBeHidden();
    await addPanelButton.click();
    await addPanelMenu.getByRole("menuitem", { name: "Terminal" }).click();
    await expect(page.getByRole("complementary", { name: "Terminal 2" })).toBeVisible();
    await expect(page.locator(".right-panel-tab", { hasText: "Terminal" })).toHaveCount(2);
    await expect(page.locator(".right-panel-tab", { hasText: "Terminal 2" })).toBeVisible();
    await page.getByRole("button", { name: "Close Terminal 2 tab" }).click();
    await expect(page.getByRole("tab", { name: "Terminal 2" })).toHaveCount(0);
    await addPanelButton.click();
    await addPanelMenu.getByRole("menuitem", { name: "Terminal" }).click();
    await expect(page.getByRole("complementary", { name: "Terminal 2" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Terminal 3" })).toHaveCount(0);
    await page.getByRole("button", { name: "Close Terminal 2 tab" }).click();
    await page.getByRole("button", { name: "Close Terminal tab", exact: true }).click();
    await expect(page.locator(".chat-right-panel")).toHaveCount(0);
    await page.getByRole("button", { name: "Open Terminal" }).click();
    await expect(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Terminal 3" })).toHaveCount(0);
    await addPanelButton.click();
    await addPanelMenu.getByRole("menuitem", { name: "Terminal" }).click();
    await expect(page.getByRole("complementary", { name: "Terminal 2" })).toBeVisible();
    await addPanelButton.click();
    await addPanelMenu.getByRole("menuitem", { name: "Artifacts" }).click();
    await expect(page.getByRole("complementary", { name: "Artifacts" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toBeVisible();
    await expect(page.locator(".right-panel-tab", { hasText: "Artifacts" })).toBeVisible();
    await expect(page.locator(".panel-empty")).toContainText("No file changes");
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
    await page.getByRole("tab", { name: /Artifacts/ }).click();
    await expect(page.getByRole("complementary", { name: "Artifacts" })).toBeVisible();

    await page.locator(".rich-composer-editor").fill("show file changes");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.getByRole("button", { name: "Open added file src/example.ts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open modified file src/config.ts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open deleted file assets/old.png" })).toBeVisible();
    await expect(page.locator(".artifact-status--added")).toContainText("A");
    await expect(page.locator(".artifact-status--modified")).toContainText("M");
    await expect(page.locator(".artifact-status--deleted")).toContainText("D");
    // Each row states the file once: name, its directory, and the change weight.
    const modifiedRow = page.getByRole("button", { name: "Open modified file src/config.ts" });
    await expect(modifiedRow.locator(".artifact-change-name")).toHaveText("config.ts");
    await expect(modifiedRow.locator(".artifact-change-dir")).toHaveText(/^‎?src$/);
    await expect(modifiedRow.locator(".artifact-change-stat")).toContainText("+1");
    await expect(modifiedRow.locator(".artifact-change-stat")).toContainText("−1");
    await expect(modifiedRow).not.toContainText("watcher event");
    await expect(page.getByRole("button", { name: "Open deleted file assets/old.png" }).locator(".artifact-change-stat")).toContainText("70 B");
    await expect(page.locator(".artifact-pane-summary")).toContainText("3 changes");
    await expect(page.locator(".artifact-pane-summary")).toContainText("1 turn");
    await expect(page.locator(".artifact-coverage-chip")).toHaveCount(0);

    // Shared capture semantics live in one pane-level note, not on every card.
    await expect(page.locator(".artifact-note")).toHaveCount(0);
    await page.getByRole("button", { name: "About file change capture" }).click();
    await expect(page.locator(".artifact-note")).toContainText("no initial directory scan");
    await expect(page.locator(".artifact-note")).toContainText("run evidence");
    await expect(page.locator(".artifact-note")).toContainText("Watched");
    await page.getByRole("button", { name: "About file change capture" }).click();
    await expect(page.locator(".artifact-note")).toHaveCount(0);

    const captureToggle = page.locator(".artifact-capture-toggle");
    await expect(captureToggle).toHaveAttribute("aria-expanded", "true");
    await captureToggle.click();
    await expect(captureToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: "Open modified file src/config.ts" })).toHaveCount(0);
    await captureToggle.click();
    await expect(page.getByRole("button", { name: "Open modified file src/config.ts" })).toBeVisible();

    await page.getByRole("button", { name: "Open modified file src/config.ts" }).click();
    const textChangeDialog = page.getByRole("dialog", { name: "config.ts" });
    await expect(textChangeDialog).toBeVisible();
    await expect(textChangeDialog.locator(".artifact-detail-facts")).toContainText("100644 → 100755");
    await expect(textChangeDialog.locator(".artifact-detail-facts")).toContainText("+1 −1");
    await expect(textChangeDialog.locator(".artifact-detail-facts")).toContainText("watcher event");
    await expect(textChangeDialog.getByRole("table", { name: "Unified file diff" })).toContainText("export const mode = 'old';");
    await expect(textChangeDialog.getByRole("table", { name: "Unified file diff" })).toContainText("export const mode = 'new';");
    await textChangeDialog.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Open deleted file assets/old.png" }).click();
    const imageChangeDialog = page.getByRole("dialog", { name: "old.png" });
    await expect(imageChangeDialog.getByRole("img", { name: "Before file snapshot" })).toBeVisible();
    await expect(imageChangeDialog).toContainText("Before");
    await imageChangeDialog.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Open Context taxonomy" }).click();
    await expect(page.getByRole("complementary", { name: "Context taxonomy" })).toBeVisible();
    await expect(page.locator(".right-panel-tab")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "Add panel" })).toBeEnabled();
    await addPanelButton.click();
    await expect(addPanelMenu).toBeVisible();
    await expect(addPanelMenu.getByRole("menuitem", { name: "Terminal" })).toBeVisible();
    await expect(addPanelMenu.getByRole("menuitem", { name: "Artifacts" })).toHaveCount(0);
    await expect(addPanelMenu.getByRole("menuitem", { name: "Context taxonomy" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // Panel shape, grouping, budget arithmetic, default expansion and filtering
    // are renderer state and are covered in tests/renderer/contextTaxonomyPanel.
    // What has to run here is the capture pipeline end to end -- what the real
    // classifier produces from a real provider request -- plus the layout half
    // jsdom cannot measure.
    // All earlier requests ran with the debug panel closed, so none of them
    // should have paid the capture/classification/storage cost.
    await expect(page.locator(".panel-empty")).toContainText("No captured context taxonomy yet");
    await expect(page.locator(".taxonomy-head")).toHaveCount(0);

    await page.locator(".rich-composer-editor").fill("show structured taxonomy");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".taxonomy-head-meta")).toContainText("provider payload");
    await expect(page.locator(".taxonomy-head-meta")).toContainText("v7");
    await expect(page.locator(".taxonomy-head-hash")).toBeVisible();
    await expect(page.locator(".taxonomy-head-approximate")).toHaveCount(0);
    const reasoningChip = page.locator(".taxonomy-chip", { hasText: "Reasoning n/a" });
    await reasoningChip.click();
    await expect(page.locator(".taxonomy-status-detail")).toContainText("DeepSeek tool-interval policy");
    await reasoningChip.click();
    const cacheChip = page.locator(".taxonomy-chip", { hasText: "Cache" });
    await cacheChip.click();
    await expect(page.locator(".taxonomy-status-detail")).toContainText("4,096");
    await expect(page.locator(".taxonomy-status-detail")).toContainText("137");
    await cacheChip.click();

    // The classifier gives a tool definition a single `metadata` part, so this
    // is where a regression that files the tool catalogue under "Metadata"
    // shows up against a real capture rather than a fixture.
    await expect(page.locator(".taxonomy-legend")).toContainText("Tool definitions");
    await expect(page.locator(".taxonomy-total-label")).toHaveText("actual input tokens");
    await expect(page.locator(".taxonomy-total-estimate")).toContainText("est.");

    await expect(page.locator(".taxonomy-request-switcher")).toHaveCount(0);

    // A draft keystroke updates App and ChatPage, but a stable debug capture is
    // unrelated to composer state. Re-rendering the full taxonomy tree here is
    // visibly expensive on long threads with megabyte-scale provider payloads.
    // Let the pane's one-second post-run refresh settle before isolating draft
    // input from that legitimate asynchronous update.
    await page.waitForTimeout(1_250);
    await page.evaluate(() => {
      window.__JASMINE_CONTEXT_TAXONOMY_RENDERS__ = 0;
    });
    await page.locator(".rich-composer-editor").fill("taxonomy render isolation probe");
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__JASMINE_CONTEXT_TAXONOMY_RENDERS__ ?? 0)).toBe(0);
    await page.locator(".rich-composer-editor").fill("");

    // At the supported 240px minimum the sticky toolbar must still follow the
    // provider identity header rather than covering it.
    const taxonomyResizeHandle = page.getByRole("separator", { name: "Resize right panel" });
    await taxonomyResizeHandle.focus();
    await page.keyboard.press("Home");
    await expect(taxonomyResizeHandle).toHaveAttribute("aria-valuenow", "240");
    await page.locator(".taxonomy-view").evaluate((node) => node.scrollTo(0, 600));
    const narrowSticky = await page.evaluate(() => {
      const head = document.querySelector(".taxonomy-head")?.getBoundingClientRect();
      const toolbar = document.querySelector(".taxonomy-toolbar")?.getBoundingClientRect();
      if (!head || !toolbar) throw new Error("Taxonomy sticky surfaces missing at the minimum width.");
      return {
        headHeight: head.height,
        toolbarAfterHead: toolbar.top >= head.bottom - 1
      };
    });
    expect(narrowSticky.headHeight).toBeGreaterThan(40);
    expect(narrowSticky.toolbarAfterHead).toBe(true);
    for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowLeft");
    await expect(taxonomyResizeHandle).toHaveAttribute("aria-valuenow", "360");

    const rawPayload = page.locator(".taxonomy-raw-payload");
    await expect(rawPayload).toBeVisible();
    await expect(rawPayload).toContainText("Sanitized raw payload");
    await expect(rawPayload.locator("pre")).toHaveCount(0);
    const currentPrompt = page.locator(".taxonomy-item", { hasText: "Current user prompt" });
    await expect(currentPrompt.locator(".taxonomy-item-body")).toHaveCount(1);
    await expect(currentPrompt.getByText("show structured taxonomy", { exact: true })).toHaveCount(1);
    await rawPayload.locator("summary").click();
    await expect(page.locator(".taxonomy-payload-order")).toContainText("messages");
    await expect(page.locator(".taxonomy-payload-order")).toContainText("tools");
    await expect(rawPayload.locator("pre")).toContainText("\"tools\"");
    await expect(rawPayload.locator("pre")).toContainText("\"messages\"");
    await rawPayload.locator("summary").click();

    const systemTaxonomy = page.locator(".taxonomy-item", { hasText: "System prompt" }).first();
    await systemTaxonomy.locator(".taxonomy-item-head").click();
    await expect(systemTaxonomy).toContainText("$.messages[0]");
    const projectContext = systemTaxonomy.locator(".taxonomy-part", { hasText: "Project context" });
    await expect(projectContext).toBeVisible();
    await projectContext.locator(".taxonomy-part-head").click();
    await expect(projectContext.locator(".markdown-message")).toContainText("Jasmine Agent Instructions");
    const skillInstructions = systemTaxonomy.locator(".taxonomy-part", { hasText: "Skill instructions" });
    await skillInstructions.locator(".taxonomy-part-head").click();
    await expect(skillInstructions.locator(".markdown-message")).toContainText("ui-ux-product-harness");

    const toolsGroup = page.locator(".taxonomy-group").filter({ has: page.locator(".taxonomy-group-name", { hasText: "Tools" }) });
    const toolTaxonomy = toolsGroup.locator(".taxonomy-item").first();
    await expect(toolTaxonomy.locator(".taxonomy-item-title")).toHaveText("read");
    await toolTaxonomy.locator(".taxonomy-item-head").click();
    await expect(toolTaxonomy).toContainText("$.tools[0]");
    await expect(toolTaxonomy.locator("pre")).toContainText("Read file contents.");
    await expect(toolTaxonomy.locator("pre")).toContainText("parameters");

    const optionsTaxonomy = page.locator(".taxonomy-item", { hasText: "Request options" });
    await expect(optionsTaxonomy).toHaveCount(1);
    await optionsTaxonomy.locator(".taxonomy-item-head").click();
    await expect(optionsTaxonomy).toContainText("request_options");
    await optionsTaxonomy.locator(".taxonomy-part", { hasText: "Option: model" }).locator(".taxonomy-part-head").click();
    await expect(optionsTaxonomy).toContainText("$.model");

    // Layout, which jsdom has no engine for. The identity header has to stay
    // put while the tree scrolls, and a JSONPath has to lose its head rather
    // than its tail -- the tail is the part that identifies it, and the panel
    // is often only wide enough for one of them.
    await page.locator(".taxonomy-view").evaluate((node) => node.scrollTo(0, 600));
    const stuck = await page.evaluate(() => {
      const head = document.querySelector(".taxonomy-head")?.getBoundingClientRect();
      const view = document.querySelector(".taxonomy-view")?.getBoundingClientRect();
      const path = document.querySelector<HTMLElement>(".taxonomy-path");
      if (!head || !view || !path) throw new Error("Taxonomy header or path geometry missing.");
      return {
        headerOffset: Math.abs(head.top - view.top),
        headerVisible: head.height > 0,
        pathDirection: getComputedStyle(path).direction
      };
    });
    expect(stuck.headerVisible).toBe(true);
    expect(stuck.headerOffset).toBeLessThanOrEqual(1);
    expect(stuck.pathDirection).toBe("rtl");
    await optionsTaxonomy.scrollIntoViewIfNeeded();
    const taxonomyScreenshotDir = path.join(rootDir, "test-results", "ui-harness", "e2e");
    await mkdir(taxonomyScreenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(taxonomyScreenshotDir, "context-taxonomy-v7.png") });
    await expect(page.locator(".message-jump-rail")).toBeVisible();
    const railGutter = await page.evaluate(() => {
      const rail = document.querySelector(".message-jump-rail")?.getBoundingClientRect();
      const panel = document.querySelector(".chat-right-panel")?.getBoundingClientRect();
      const bubbles = Array.from(document.querySelectorAll<HTMLElement>(".user-bubble")).map((bubble) => bubble.getBoundingClientRect());
      if (!rail || !panel || bubbles.length < 2) throw new Error("Right-panel rail geometry missing.");
      return {
        railBeforePanel: rail.right <= panel.left,
        minBubbleGap: Math.min(...bubbles.map((bubble) => rail.left - bubble.right))
      };
    });
    expect(railGutter.railBeforePanel).toBe(true);
    expect(railGutter.minBubbleGap).toBeGreaterThanOrEqual(12);
    await page.getByRole("tab", { name: /Artifacts/ }).click();
    // Context taxonomy is a debug-only view. Inactive or collapsed panels must
    // release the classified tree instead of leaving a large hidden DOM alive.
    await expect(page.locator(".taxonomy-view")).toHaveCount(0);
    const contextTab = page.locator(".right-panel-tab", { hasText: "Context taxonomy" });
    const contextCloseButton = contextTab.getByRole("button", { name: "Close Context taxonomy tab" });
    await expect(contextCloseButton).toHaveCSS("opacity", "0");
    await contextTab.hover();
    await expect(contextCloseButton).toHaveCSS("opacity", "1");
    await contextCloseButton.click();
    await expect(page.getByRole("complementary", { name: "Context taxonomy" })).toBeHidden();
  });

  test("artifact capture coverage trouble is announced on the capture it belongs to", async () => {
    const { page } = harness;
    await startEmptyThread(page);
    await page.getByRole("button", { name: "Open Artifacts" }).click();
    await expect(page.getByRole("complementary", { name: "Artifacts" })).toBeVisible();

    await page.locator(".rich-composer-editor").fill("show partial file changes");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.getByRole("button", { name: "Open modified file src/partial.ts" })).toBeVisible();

    const coverageChip = page.getByRole("button", { name: "Partial coverage" });
    await expect(coverageChip).toBeVisible();
    await expect(coverageChip).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".artifact-capture .artifact-note")).toHaveCount(0);
    await coverageChip.click();
    const coverageNote = page.locator(".artifact-capture .artifact-note");
    await expect(coverageNote).toContainText("outside the approved write and edit targets");
    await expect(coverageNote).toContainText("not tracked in managed-tools-only mode");
    await expect(coverageNote).toContainText("Watcher event queue overflowed");
    await expect(coverageNote).toContainText("root-unreadable");
    await coverageChip.click();
    await expect(page.locator(".artifact-capture .artifact-note")).toHaveCount(0);

    // A stored diff that moves no lines reports nothing rather than the whole
    // file size, and the panel note must not call managed evidence a watcher.
    const modeOnlyRow = page.getByRole("button", { name: "Open modified file scripts/run.sh" });
    await expect(modeOnlyRow.locator(".artifact-change-stat")).toHaveCount(0);
    await page.getByRole("button", { name: "About file change capture" }).click();
    const basisNote = page.locator(".artifact-pane > .artifact-note");
    await expect(basisNote).toContainText("Managed mode records approved write and edit targets only");
    await expect(basisNote).not.toContainText("Watcher mode");
    // A managed target is stored as its parent directory; nothing else in that
    // directory was observed, so it is not a watched root.
    await expect(basisNote).not.toContainText("Watched");

    await modeOnlyRow.click();
    const modeOnlyDialog = page.getByRole("dialog", { name: "run.sh" });
    await expect(modeOnlyDialog.locator(".artifact-detail-facts")).toContainText("100644 → 100755");
    await expect(modeOnlyDialog.locator(".artifact-detail-facts")).not.toContainText("+0");
  });

  test("the latest opt-in context taxonomy capture restores after restart", async ({}, testInfo) => {
    let { page } = harness;
    const userDataDir = harness.userDataDir;
    await startEmptyThread(page);
    await page.getByRole("button", { name: "Open Context taxonomy" }).click();
    await expect(page.locator(".panel-empty")).toContainText("No captured context taxonomy yet");
    await page.locator(".rich-composer-editor").fill("show structured taxonomy");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");
    const threadId = await page.evaluate(async () => (await window.jasmine.listThreads())[0]?.id ?? "");
    const beforeRestart = await page.evaluate(async (id) => window.jasmine.listThreadContextTaxonomy(id), threadId);
    expect(beforeRestart.captures).toHaveLength(1);
    const messages = await page.evaluate(async (id) => window.jasmine.listMessages(id), threadId);
    expect(messages.flatMap((message) => message.timeline ?? []).some((item) => item.kind === "system" && item.customType === "context-taxonomy")).toBe(false);

    await quitElectron(harness.app);
    harness = await launchJasmine(`${testInfo.title.replace(/\W+/g, "-")}-restart`, userDataDir);
    page = harness.page;
    const restored = await page.evaluate(async (id) => {
      const captures = await window.jasmine.listThreadContextTaxonomy(id);
      const selected = captures.captures.at(-1);
      if (!selected) throw new Error("Restored capture missing.");
      const detail = await window.jasmine.getContextTaxonomy(selected.id);
      const raw = await window.jasmine.getContextTaxonomyRaw({ captureId: selected.id, length: 65_536 });
      return { captures, detail, raw };
    }, threadId);
    expect(restored.captures.captures).toHaveLength(1);
    expect(restored.detail.taxonomy.items.some((item) => item.kind === "tool_definition")).toBe(true);
    expect(restored.detail.taxonomy.rawPayload).toBeUndefined();
    expect(restored.raw.text).toContain("\"tools\"");
    expect(restored.raw.sha256).toHaveLength(64);
  });

  test("the opt-in taxonomy snapshot rolls forward for retry and edit", async () => {
    const { page } = harness;
    await startEmptyThread(page);
    await page.getByRole("button", { name: "Open Context taxonomy" }).click();
    await page.locator(".rich-composer-editor").fill("show structured taxonomy");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");

    const captureState = async () => page.evaluate(async () => {
      const threadId = (await window.jasmine.listThreads())[0]?.id;
      if (!threadId) throw new Error("Taxonomy test thread is missing.");
      const response = await window.jasmine.listThreadContextTaxonomy(threadId);
      return { count: response.captures.length, id: response.captures.at(-1)?.id ?? null };
    });
    const sentCapture = await captureState();
    expect(sentCapture.count).toBe(1);
    expect(sentCapture.id).toBeTruthy();

    await page.locator(".assistant-block").last().getByRole("button", { name: "Regenerate this response" }).click();
    await expect.poll(captureState).toEqual({ count: 1, id: expect.not.stringMatching(sentCapture.id!) });
    const retryCapture = await captureState();

    const userMessage = page.locator(".user-message-wrap").last();
    await userMessage.hover();
    await userMessage.getByRole("button", { name: "Edit message" }).click();
    await page.locator(".rich-composer-editor").fill("show structured taxonomy edited");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(captureState).toEqual({ count: 1, id: expect.not.stringMatching(retryCapture.id!) });
  });

  test("file change artifacts and lazy details restore after restart", async ({}, testInfo) => {
    let { page } = harness;
    const userDataDir = harness.userDataDir;
    await startEmptyThread(page);
    await page.locator(".rich-composer-editor").fill("show file changes");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");
    const threadId = await page.evaluate(async () => (await window.jasmine.listThreads())[0]?.id ?? "");
    const beforeRestart = await page.evaluate(async (id) => window.jasmine.listThreadArtifacts(id), threadId);
    expect(beforeRestart.captures).toHaveLength(1);
    expect(beforeRestart.captures[0].changes).toHaveLength(3);

    await quitElectron(harness.app);
    harness = await launchJasmine(`${testInfo.title.replace(/\W+/g, "-")}-restart`, userDataDir);
    page = harness.page;
    const restored = await page.evaluate(async (id) => {
      const artifacts = await window.jasmine.listThreadArtifacts(id);
      const change = artifacts.captures[0]?.changes.find((item) => item.relativePath === "src/config.ts");
      if (!change) throw new Error("Restored file change missing.");
      return {
        artifacts,
        detail: await window.jasmine.getThreadArtifactDetail(id, change.id)
      };
    }, threadId);
    expect(restored.artifacts.captures).toHaveLength(1);
    expect(restored.detail.change.unifiedDiff).toContain("export const mode = 'new';");

    const artifactsPanel = page.getByRole("complementary", { name: "Artifacts" });
    if (!(await artifactsPanel.isVisible())) await page.getByRole("button", { name: "Open Artifacts" }).click();
    await expect(artifactsPanel).toBeVisible();
    await expect(page.getByRole("button", { name: "Open modified file src/config.ts" })).toBeVisible();

    await page.getByRole("button", { name: "Open modified file src/config.ts" }).click();
    await expect(page.getByRole("dialog", { name: "config.ts" })).toBeVisible();
    // Trigger the real New chat action while the modal is open. DOM activation
    // mirrors a route change from another app surface without pointer events
    // being intercepted by the dialog backdrop.
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('.side-top button[aria-label="New chat"]');
      if (!button) throw new Error("New chat action is unavailable.");
      button.click();
    });
    await expect(page.getByRole("dialog", { name: "config.ts" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Open modified file src/config.ts" })).toHaveCount(0);
    await expect(artifactsPanel.locator(".panel-empty")).toContainText("No file changes");
    const isolationThread = await page.evaluate(async (firstThreadId) => {
      const thread = (await window.jasmine.listThreads()).find((candidate) => candidate.id !== firstThreadId);
      if (!thread) throw new Error("Artifact isolation thread was not created.");
      return thread;
    }, threadId);

    const isolatedScratch = await page.evaluate(async ({ firstThreadId, secondThreadId }) => {
      await window.jasmine.sendChatMessage({
        threadId: secondThreadId,
        content: "show file changes",
        messages: [],
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        toolsEnabled: true
      });
      const [first, second, terminal] = await Promise.all([
        window.jasmine.listThreadArtifacts(firstThreadId),
        window.jasmine.listThreadArtifacts(secondThreadId),
        window.jasmine.startTerminal({ threadId: secondThreadId })
      ]);
      await window.jasmine.stopTerminal({ sessionId: terminal.id });
      return {
        firstRoot: first.captures[0]?.roots[0],
        secondRoot: second.captures[0]?.roots[0],
        terminalCwd: terminal.cwd
      };
    }, { firstThreadId: threadId, secondThreadId: isolationThread.id });
    expect(isolatedScratch.firstRoot).toBeTruthy();
    expect(isolatedScratch.secondRoot).toBeTruthy();
    expect(path.resolve(isolatedScratch.firstRoot)).not.toBe(path.resolve(isolatedScratch.secondRoot));
    expect(path.resolve(isolatedScratch.terminalCwd)).toBe(path.resolve(isolatedScratch.secondRoot));
  });

  test("context taxonomy refreshes after a slow loop and exposes source-ordered taxonomy sections", async () => {
    const { page } = harness;
    await startEmptyThread(page);
    const threadRoute = await navigationPath(page);
    await page.getByRole("button", { name: "Open Context taxonomy" }).click();
    await expect(page.getByRole("complementary", { name: "Context taxonomy" })).toBeVisible();
    await expect.poll(() => navigationPath(page)).toBe(`${threadRoute}/right-panel/context`);
    await expect(page.locator(".panel-empty")).toContainText("No captured context taxonomy yet");

    await page.locator(".rich-composer-editor").fill("show structured taxonomy with unclassified taxonomy slow response slow timeline");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block.live-message")).toBeVisible();
    // Let the 1s panel throttle settle on the stable streaming message id. The
    // final persisted assistant has the same list length but a different id.
    await page.waitForTimeout(1_250);
    await waitForStableAssistant(page, "Slow response complete.");

    // Exact regression: the just-finished run must appear without another user
    // turn, panel reopen, or manual refresh.
    await expect(page.locator(".taxonomy-head-meta")).toContainText("provider payload", { timeout: 5_000 });
    await expect(page.locator(".taxonomy-head-meta")).toContainText("v7");

    // A field no classifier rule matched is the panel's most load-bearing
    // signal, so it stays a coloured chip that names the exact JSONPath.
    const unknownChip = page.locator(".taxonomy-chip", { hasText: "unknown field" });
    await expect(unknownChip).toHaveText("1 unknown field");
    await expect(unknownChip).toHaveAttribute("data-tone", "bad");
    await unknownChip.click();
    await expect(page.locator(".taxonomy-status-detail")).toContainText("$.future_context_envelope");

    await page.locator(".taxonomy-raw-payload > summary").click();
    await expect(page.locator(".taxonomy-payload-order code")).toHaveText([
      "model", "messages", "stream", "future_context_envelope", "tools"
    ]);
    await page.locator(".taxonomy-raw-payload > summary").click();

    // Sections carry the grouping the classifier's order implies, and a section
    // with nothing in it does not take up a heading -- this first turn has no
    // conversation history yet.
    await expect(page.locator(".taxonomy-group-name")).toHaveText([
      "Instructions", "Current prompt", "Tools", "Request options", "Unknown fields"
    ]);
    const options = page.locator(".taxonomy-item", { hasText: "Request options" });
    await expect(options).toHaveCount(1);
    await options.locator(".taxonomy-item-head").click();
    await expect(options.locator(".taxonomy-part")).toHaveCount(2);
    await expect(options.locator(".taxonomy-part").nth(0)).toContainText("Option: model");
    await expect(options.locator(".taxonomy-part").nth(1)).toContainText("Option: stream");

    const unclassified = page.locator(".taxonomy-item", { hasText: "Other payload fields" });
    await unclassified.locator(".taxonomy-item-head").click();
    await expect(unclassified).toContainText("classifier coverage fixture");
    await expect(unclassified).toContainText("$.future_context_envelope");

    // Everything but the current prompt starts collapsed, so the panel opens as
    // a map rather than as every part of every message at once.
    const systemMessage = page.locator(".taxonomy-item", { has: page.locator(".taxonomy-item-title", { hasText: "System prompt" }) });
    await expect(systemMessage).not.toHaveAttribute("open", "");
    await systemMessage.locator(".taxonomy-item-head").click();
    await expect(systemMessage).toHaveAttribute("open", "");
    await expect(systemMessage.locator(".taxonomy-part").first()).not.toHaveAttribute("open", "");
    await page.getByRole("button", { name: "Expand all" }).click();
    await expect.poll(() => systemMessage.locator(".taxonomy-part").evaluateAll((parts) => parts.length > 0 && parts.every((part) => (part as HTMLDetailsElement).open))).toBe(true);
  });

});
