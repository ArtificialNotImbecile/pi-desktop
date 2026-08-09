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
    await page.getByRole("combobox", { name: "Command palette" }).fill("plugin");
    await page.keyboard.press("Enter");
    await expect(page.locator(".settings-panel")).toBeVisible();
    await expect(page.locator(".settings-nav").getByRole("button", { name: "Plugins" })).toHaveClass(/active/);
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
    await expect(page.locator(".panel-empty")).toContainText("No artifacts");
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Terminal" })).toBeVisible();
    await page.getByRole("tab", { name: /Artifacts/ }).click();
    await expect(page.getByRole("complementary", { name: "Artifacts" })).toBeVisible();

    await page.locator(".rich-composer-editor").fill("show write timeline");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".right-panel-row", { hasText: "src/example.ts" })).toBeVisible();

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
    await expect(page.locator(".taxonomy-summary")).toContainText("schema v5");
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
    await expect(page.locator(".taxonomy-payload-shape")).toContainText("Payload shape");
    await page.locator(".taxonomy-payload-shape > summary").click();
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
    await projectContext.locator("summary").click();
    await expect(projectContext.locator(".markdown-message")).toContainText("Jasmine Agent Instructions");
    const skillInstructions = systemTaxonomy.locator(".taxonomy-part", { hasText: "Skill instructions" });
    await skillInstructions.locator("summary").click();
    await expect(skillInstructions.locator(".markdown-message")).toContainText("ui-ux-product-harness");
    const toolTaxonomy = page.locator(".taxonomy-item", { hasText: "Tool definition: read" });
    await expect(toolTaxonomy).toBeVisible();
    await expect(toolTaxonomy.locator(".taxonomy-item-details > summary").first()).toContainText("Tool: read");
    await expect(toolTaxonomy).toContainText("$.tools[0]");
    await expect(toolTaxonomy.locator(".taxonomy-item-details").first()).toHaveAttribute("open", "");
    await expect(toolTaxonomy.locator(".taxonomy-part", { hasText: "Tool definition" })).toBeVisible();
    await expect(toolTaxonomy.locator("pre")).toContainText("Read file contents.");
    await expect(toolTaxonomy.locator("pre")).toContainText("parameters");
    const optionsTaxonomy = page.locator(".taxonomy-item", { hasText: "Provider request options" });
    await expect(optionsTaxonomy).toBeVisible();
    await expect(optionsTaxonomy).toContainText("request_options");
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
