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
  createSshConfigFixture,
  enableWebSearchFallback,
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

  test("command palette routes to settings, panels, and tool surfaces @smoke", async () => {
    const { page } = harness;

    await page.keyboard.press("Control+K");
    await expect(page.locator(".command-panel")).toBeVisible();
    await page.getByRole("combobox", { name: "Command palette" }).fill("activity");
    await page.keyboard.press("Enter");
    await expect(page.locator(".activity-panel")).toBeVisible();
    await page.locator(".activity-panel").getByRole("button", { name: "Close activity panel" }).click();

    await page.keyboard.press("Control+K");
    await page.getByRole("combobox", { name: "Command palette" }).fill("memory");
    await page.keyboard.press("Enter");
    await expect(page.locator(".memory-panel")).toBeVisible();
    await page.locator(".memory-panel").getByRole("button", { name: "Close memory panel" }).click();

    await page.keyboard.press("Control+K");
    await page.getByRole("combobox", { name: "Command palette" }).fill("web");
    await page.keyboard.press("Enter");
    await expect(page.locator(".settings-panel")).toBeVisible();
    await expect(page.locator(".settings-detail")).toContainText("Use web search");
    await page.getByRole("button", { name: "Close settings" }).click();

    await page.keyboard.press("Control+K");
    await page.getByRole("combobox", { name: "Command palette" }).fill("package");
    await page.keyboard.press("Enter");
    await expect(page.locator(".settings-panel")).toBeVisible();
    await expect(page.locator(".settings-nav").getByRole("button", { name: "Packages" })).toHaveClass(/active/);
    await page.getByRole("button", { name: "Close settings" }).click();

    await page.keyboard.press("Control+K");
    await page.getByRole("combobox", { name: "Command palette" }).fill("mcp");
    await page.keyboard.press("Enter");
    await expect(page.locator(".settings-panel")).toBeVisible();
    await expect(page.locator(".settings-nav").getByRole("button", { name: "MCP Servers" })).toHaveClass(/active/);
    await expect(page.locator(".settings-detail")).toContainText("Marketplace");
    await page.getByRole("button", { name: "Close settings" }).click();

    await page.keyboard.press("Control+K");
    await page.getByRole("combobox", { name: "Command palette" }).fill("search");
    await page.keyboard.press("Enter");
    await expect(page.locator(".search-backdrop")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+K");
    await page.getByRole("combobox", { name: "Command palette" }).fill("toggle");
    await page.keyboard.press("Enter");
    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);

    await page.keyboard.press("Control+K");
    await page.getByRole("combobox", { name: "Command palette" }).fill("catalog");
    await page.keyboard.press("Enter");
    await expect(page.locator(".ui-catalog")).toBeVisible();
    await expect(page.locator(".ui-catalog")).toContainText("Buttons");
    await expect(page.locator(".ui-catalog")).toContainText("Settings rows");
    await expect(page.locator(".ui-catalog")).toContainText("Code and logs");
    await page.mouse.move(0, 0);
    await page.locator(".ui-catalog").getByRole("button", { name: "Settings" }).hover();
    await expect(page.locator(".ui-tooltip", { hasText: "Settings" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Disabled switch" })).toHaveAttribute("aria-checked", "false");
    await page.getByRole("switch", { name: "Disabled switch" }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("switch", { name: "Disabled switch" })).toHaveAttribute("aria-checked", "false");
    const dialogTrigger = page.locator(".ui-catalog").getByRole("button", { name: "Open dialog sample" });
    await dialogTrigger.click();
    await expect(page.locator(".ui-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ui-dialog")).toBeHidden();
    await expect(dialogTrigger).toBeFocused();
    await page.locator(".ui-catalog").getByRole("button", { name: "Close" }).click();
    await expect(page.locator(".ui-catalog")).toBeHidden();

    await page.keyboard.press("Control+F");
    await expect(page.locator(".search-backdrop")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+N");
    await expect(page.locator(".empty-state")).toBeVisible();
  });

  test("right panel terminal resizes and preserves terminal session", async () => {
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

  test("right panel terminal tab labels reuse closed display names", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.getByRole("button", { name: "Open Terminal" }).click();
    await expect(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
    const addPanelButton = page.getByRole("button", { name: "Add panel" });
    const addPanelMenu = page.getByRole("menu", { name: "Add panel menu" });
    await addPanelButton.click();
    await addPanelMenu.getByRole("menuitem", { name: "Terminal" }).click();
    await expect(page.getByRole("complementary", { name: "Terminal 2" })).toBeVisible();

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
    await expect(page.locator(".taxonomy-summary")).toContainText("deepseek-v4-flash");
    await expect(page.locator(".taxonomy-warning-card")).toContainText("Reconstructed approximation");
    await expect(page.locator(".taxonomy-item").first()).toContainText("system");
    await expect(page.locator(".taxonomy-item").last()).toContainText("Current user prompt");
    await expect(page.locator(".taxonomy-item", { hasText: "Current user prompt" }).locator(".taxonomy-item-details").first()).toHaveAttribute("open", "");

    await page.locator(".rich-composer-editor").fill("show structured taxonomy");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".taxonomy-summary")).toContainText("provider-payload");
    await expect(page.locator(".taxonomy-summary")).toContainText("schema v7");
    await expect(page.locator(".taxonomy-summary")).toContainText("full sanitized payload sha256");
    await expect(page.locator(".taxonomy-warning-card")).toHaveCount(0);
    await expect(page.locator(".taxonomy-validation-card")).toContainText("Reasoning retention: Not required");
    await expect(page.locator(".taxonomy-validation-card")).toContainText("DeepSeek tool-interval policy");
    await expect(page.locator(".taxonomy-summary-counts")).toContainText("actual input tokens");
    await expect(page.locator(".taxonomy-summary-counts")).toContainText("estimated by part");
    await expect(page.locator(".taxonomy-composition")).toContainText("Estimated composition");
    await expect(page.locator(".taxonomy-cache-card")).toContainText("Provider usage");
    await expect(page.locator(".taxonomy-cache-card")).toContainText("4,096 hit");
    await expect(page.locator(".taxonomy-cache-card")).toContainText("137 miss");
    const requestSwitcher = page.locator(".taxonomy-request-switcher");
    await expect(requestSwitcher.getByRole("button", { name: "1/2" })).toBeVisible();
    await expect(requestSwitcher.getByRole("button", { name: "2/2" })).toHaveAttribute("aria-pressed", "true");
    await requestSwitcher.getByRole("button", { name: "1/2" }).click();
    await expect(requestSwitcher.getByRole("button", { name: "1/2" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".taxonomy-payload-shape")).toContainText("Raw payload shape");
    const payloadShapeSummary = page.locator(".taxonomy-payload-shape > summary");
    await expect(payloadShapeSummary).toContainText("Raw payload shape");
    await payloadShapeSummary.click();
    await expect(page.locator(".taxonomy-payload-order")).toContainText("messages");
    await expect(page.locator(".taxonomy-payload-order")).toContainText("tools");
    const rawPayload = page.locator(".taxonomy-raw-payload");
    await expect(rawPayload).toBeVisible();
    await expect(rawPayload).toContainText("Sanitized raw provider payload");
    await expect(rawPayload.locator("pre")).toHaveCount(0);
    const currentPrompt = page.locator(".taxonomy-item", { hasText: "Current user prompt" });
    await expect(currentPrompt.getByText("show structured taxonomy", { exact: true })).toHaveCount(1);
    await rawPayload.locator("summary").click();
    await expect(rawPayload.locator("pre")).toContainText("\"tools\"");
    await expect(rawPayload.locator("pre")).toContainText("\"messages\"");
    const systemTaxonomy = page.locator(".taxonomy-item", { hasText: "System prompt" }).first();
    await systemTaxonomy.locator(".taxonomy-item-details > summary").click();
    await expect(systemTaxonomy).toContainText("~");
    await expect(systemTaxonomy).toContainText("$.messages[0]");
    await expect(systemTaxonomy).toContainText("System prompt");
    await expect(systemTaxonomy.locator(".taxonomy-part", { hasText: "System prompt" })).toBeVisible();
    const projectContext = systemTaxonomy.locator(".taxonomy-part", { hasText: "Project context" });
    await expect(projectContext).toBeVisible();
    await expect(projectContext).toHaveAttribute("open", "");
    await expect(projectContext.locator(".markdown-message")).toContainText("Jasmine Agent Instructions");
    const skillInstructions = systemTaxonomy.locator(".taxonomy-part", { hasText: "Skill instructions" });
    await expect(skillInstructions).toHaveAttribute("open", "");
    await expect(skillInstructions.locator(".markdown-message")).toContainText("ui-ux-product-harness");
    const toolTaxonomy = page.locator(".taxonomy-item", { hasText: "Tool definition: read" });
    await expect(toolTaxonomy).toBeVisible();
    await expect(toolTaxonomy.locator(".taxonomy-item-details > summary").first()).toContainText("Tool: read");
    await expect(toolTaxonomy).toContainText("$.tools[0]");
    await expect(toolTaxonomy.locator(".taxonomy-item-details").first()).toHaveAttribute("open", "");
    await expect(toolTaxonomy.locator(".taxonomy-part", { hasText: "Tool definition" })).toBeVisible();
    await expect(toolTaxonomy.locator("pre")).toContainText("Read file contents.");
    await expect(toolTaxonomy.locator("pre")).toContainText("parameters");
    const optionsTaxonomy = page.locator(".taxonomy-item", { hasText: "Request options" });
    await expect(optionsTaxonomy).toHaveCount(1);
    await expect(optionsTaxonomy).toBeVisible();
    await expect(optionsTaxonomy).toContainText("request_options");
    await expect(optionsTaxonomy).toContainText("$.model");
    const optionsDetails = optionsTaxonomy.locator(".taxonomy-item-details");
    if (!(await optionsDetails.getAttribute("open"))) {
      await optionsDetails.locator(":scope > summary").click();
    }
    const rawPayloadDetails = page.locator(".taxonomy-raw-payload");
    if (await rawPayloadDetails.getAttribute("open")) {
      await rawPayloadDetails.locator(":scope > summary").click();
    }
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

    await modeOnlyRow.click();
    const modeOnlyDialog = page.getByRole("dialog", { name: "run.sh" });
    await expect(modeOnlyDialog.locator(".artifact-detail-facts")).toContainText("100644 → 100755");
    await expect(modeOnlyDialog.locator(".artifact-detail-facts")).not.toContainText("+0");
  });

  test("context taxonomy captures restore independently after restart", async ({}, testInfo) => {
    let { page } = harness;
    const userDataDir = harness.userDataDir;
    await startEmptyThread(page);
    await page.locator(".rich-composer-editor").fill("show structured taxonomy");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");
    const threadId = await page.evaluate(async () => (await window.jasmine.listThreads())[0]?.id ?? "");
    const beforeRestart = await page.evaluate(async (id) => window.jasmine.listThreadContextTaxonomy(id), threadId);
    expect(beforeRestart.captures).toHaveLength(2);
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
    expect(restored.captures.captures).toHaveLength(2);
    expect(restored.detail.taxonomy.items.some((item) => item.kind === "tool_definition")).toBe(true);
    expect(restored.detail.taxonomy.rawPayload).toBeUndefined();
    expect(restored.raw.text).toContain("\"tools\"");
    expect(restored.raw.sha256).toHaveLength(64);
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
    await page.getByRole("button", { name: "Open Context taxonomy" }).click();
    await expect(page.getByRole("complementary", { name: "Context taxonomy" })).toBeVisible();
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
    await expect(page.locator(".taxonomy-summary")).toContainText("provider-payload", { timeout: 5_000 });
    await expect(page.locator(".taxonomy-summary")).toContainText("schema v7");
    await expect(page.locator(".taxonomy-unclassified-card")).toContainText("1 unclassified payload field");
    await expect(page.locator(".taxonomy-unclassified-card")).toContainText("$.future_context_envelope");

    await page.locator(".taxonomy-payload-shape > summary").click();
    await expect(page.locator(".taxonomy-payload-order code")).toHaveText([
      "model", "messages", "stream", "future_context_envelope", "tools"
    ]);
    const options = page.locator(".taxonomy-item", { hasText: "Request options" });
    await expect(options).toHaveCount(1);
    await expect(options.locator(".taxonomy-part")).toHaveCount(2);
    await expect(options.locator(".taxonomy-part").nth(0)).toContainText("Option: model");
    await expect(options.locator(".taxonomy-part").nth(1)).toContainText("Option: stream");
    await expect(page.locator(".taxonomy-derived-note")).toContainText("messages, tools, request options, then other fields");
    const unclassified = page.locator(".taxonomy-item", { hasText: "future_context_envelope" });
    await expect(unclassified.locator(".taxonomy-item-details")).toHaveAttribute("open", "");
    await expect(unclassified.locator(".taxonomy-part-unclassified")).toHaveAttribute("open", "");
    await expect(unclassified).toContainText("classifier coverage fixture");

    const systemMessage = page.locator(".taxonomy-item", { has: page.locator(".taxonomy-item-title strong", { hasText: "System prompt" }) });
    const systemDetails = systemMessage.locator(".taxonomy-item-details");
    await expect(systemDetails).not.toHaveAttribute("open", "");
    await systemDetails.locator(":scope > summary").click();
    await expect(systemDetails).toHaveAttribute("open", "");
    await expect.poll(() => systemMessage.locator(".taxonomy-part").evaluateAll((parts) => parts.length > 0 && parts.every((part) => (part as HTMLDetailsElement).open))).toBe(true);
  });

  test("search shows an empty state for no results", async () => {
    const { page } = harness;

    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByPlaceholder("Search chats").fill("Greeting");
    await page.keyboard.press("Enter");
    await expect(page.locator(".chat-header")).toContainText("Greeting");

    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByPlaceholder("Search chats").fill("no-chat-with-this-title");

    await expect(page.locator(".search-empty")).toHaveText("No chats found");
  });
});
