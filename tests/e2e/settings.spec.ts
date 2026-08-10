import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

const require = createRequire(import.meta.url);
const packageMetadata = require("../../package.json") as { version: string };

test.describe("Jasmine settings", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("unreleased Chrome control settings stay out of the navigation", async () => {
    const { page } = harness;

    await openSettings(page);
    await expect(page.locator(".settings-nav").getByRole("button", { name: "Chrome Control" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Chrome control" })).toHaveCount(0);
  });

  test("entry brand settings update the new chat surface and persist after restart", async ({}, testInfo) => {
    let { page } = harness;

    await openSettings(page);
    await page.getByRole("textbox", { name: "Entry main title" }).fill("Hiri workspace");
    await page.getByRole("textbox", { name: "Entry subtitle" }).fill("One idea, one paste, one next step.");
    await page.locator(".general-brand-row").getByRole("button", { name: "Choose Logo" }).click();
    await saveSettings(page);
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator(".side-top").getByRole("button", { name: "New chat" }).click();
    await expect(page.locator(".empty-state h1")).toHaveText("Hiri workspace");
    await expect(page.locator(".empty-state p")).toHaveText("One idea, one paste, one next step.");
    await expect(page.locator(".brand-mark")).toHaveAttribute("src", /^data:image\/png;base64,/);

    const userDataDir = harness.userDataDir;
    await quitElectron(harness.app);
    harness = await launchJasmine(`${testInfo.title.replace(/\W+/g, "-")}-restart`, userDataDir);
    page = harness.page;
    await page.locator(".side-top").getByRole("button", { name: "New chat" }).click();
    await expect(page.locator(".empty-state h1")).toHaveText("Hiri workspace");
    await expect(page.locator(".empty-state p")).toHaveText("One idea, one paste, one next step.");
    await expect(page.locator(".brand-mark")).toHaveAttribute("src", /^data:image\/png;base64,/);
  });

  test("settings panel opens with single-column nav and section icons", async () => {
    const { page } = harness;

    await openSettings(page);
    await expect(page.locator(".settings-nav")).toHaveCSS("user-select", "none");
    await page.locator(".settings-detail").click({ position: { x: 12, y: 12 } });
    await page.keyboard.press("Control+A");
    const selectedSettingsText = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selectedSettingsText).not.toContain("Prompt Templates");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(page.locator(".settings-panel")).toHaveClass(/single-nav/);
    await expect(page.locator(".settings-subnav")).toHaveCount(0);
    await expect(page.locator(".settings-nav button .icon")).toHaveCount(12);
    await expect(page.locator(".settings-detail")).not.toContainText("Command palette");
    await expect(page.locator(".settings-detail")).not.toContainText("Theme");
    await expect(page.locator(".settings-detail .settings-header")).toHaveCount(0);
  });

  test("tool model selection saves and persists @smoke", async () => {
    const { page } = harness;

    await openSettings(page);
    await expect(page.getByRole("combobox", { name: "Tool model provider" })).toHaveValue("deepseek");
    await expect(page.getByRole("combobox", { name: "Tool model", exact: true })).toHaveValue("deepseek-v4-flash");
    await expect(page.getByRole("combobox", { name: "Tool model reasoning" })).toHaveValue("off");
    await page.getByRole("combobox", { name: "Tool model provider" }).selectOption("moonshot");
    await page.getByRole("combobox", { name: "Tool model reasoning" }).selectOption("minimal");
    await saveSettings(page);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).toolModel)).toMatchObject({
      providerId: "moonshot",
      modelId: "kimi-k2.6",
      reasoningEffort: "minimal"
    });
  });

  test("entry brand fields save and reflect in the new chat empty state @smoke", async () => {
    const { page } = harness;

    await page.locator(".side-top").getByRole("button", { name: "New chat" }).click();
    await expect(page.locator(".empty-state h1")).toHaveText("Talk to yourself.");
    await expect(page.locator(".empty-state p")).toHaveText("Jasmine listens. Jasmine learns. Jasmine becomes yours.");
    await expect(page.locator(".brand-mark")).toHaveAttribute("src", /jasmine-logo/);
    await openSettings(page);
    await expect(page.locator(".general-brand-row")).toContainText("Entry brand");
    await expect(page.locator(".brand-logo-preview img")).toBeVisible();
    await page.getByRole("textbox", { name: "Entry main title" }).fill("Custom helper");
    await page.getByRole("textbox", { name: "Entry subtitle" }).fill("Custom subtitle for this workspace.");
    await page.locator(".general-brand-row").getByRole("button", { name: "Choose Logo" }).click();
    await saveSettings(page);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).brand)).toMatchObject({
      mainTitle: "Custom helper",
      subtitle: "Custom subtitle for this workspace.",
      logoDataUrl: expect.stringMatching(/^data:image\/png;base64,/)
    });
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.locator(".side-top").getByRole("button", { name: "New chat" }).click();
    await expect(page.locator(".empty-state")).toBeVisible();
    await expect(page.locator(".brand-mark")).toBeVisible();
    await expect(page.locator(".empty-state h1")).toHaveText("Custom helper");
    await expect(page.locator(".empty-state p")).toHaveText("Custom subtitle for this workspace.");
    await expect(page.locator(".brand-mark")).toHaveAttribute("src", /^data:image\/png;base64,/);
  });

  test("appearance preset applies and persists @smoke", async () => {
    const { page } = harness;

    await openSettings(page, "Appearance");
    await expect(page.locator(".settings-subnav")).toHaveCount(0);
    await expect(page.locator(".settings-detail .settings-header")).toHaveCount(0);
    await expect(page.locator(".appearance-presets").getByRole("button", { name: /Codex/ })).toBeVisible();
    await page.locator(".appearance-presets").getByRole("button", { name: /Jasmine/ }).click();
    await expect(page.locator('input[aria-label="Accent hex color"]')).toHaveValue("#0b74de");
    await expect(page.locator('input[aria-label="Surface hex color"]')).toHaveValue("#fffdf7");
    await expect(page.locator('input[aria-label="Ink hex color"]')).toHaveValue("#15191f");
    await expect(page.locator('input[aria-label="Success hex color"]')).toHaveValue("#008f4c");
    await expect(page.locator('input[aria-label="Danger hex color"]')).toHaveValue("#d13326");
    await page.locator(".appearance-presets").getByRole("button", { name: /Codex/ }).click();
    await expect(page.locator('input[aria-label="Accent hex color"]')).toHaveValue("#0169cc");
    await page.locator(".appearance-presets").getByRole("button", { name: /Jasmine/ }).click();
    await saveSettings(page);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).appearance)).toMatchObject({
      accent: "#0b74de",
      surface: "#fffdf7",
      ink: "#15191f",
      success: "#008f4c",
      danger: "#d13326"
    });
    // Detailed computed-color verification (panel/preview/primary RGB) lives in the visual harness.
    await expect.poll(async () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#0b74de");
  });

  test("settings nav reaches memory, activity, web search, packages, and about sections", async () => {
    const { page } = harness;

    await expect(page).toHaveTitle("Jasmine — The desktop app for Pi");
    await openSettings(page, "Memory");
    await expect(page.locator(".settings-subnav")).toHaveCount(0);
    await expect(page.locator(".settings-detail")).toContainText("Saved memories");
    await expect(page.locator(".settings-detail").getByRole("button", { name: "Open Memory" })).toBeVisible();
    await page.locator(".settings-nav").getByRole("button", { name: "Activity" }).click();
    await expect(page.locator(".settings-subnav")).toHaveCount(0);
    await expect(page.locator(".settings-detail")).toContainText("Recorder controls");
    await expect(page.locator(".settings-detail").getByRole("button", { name: "Open Activity" })).toBeVisible();
    await page.locator(".settings-nav").getByRole("button", { name: "Web Search" }).click();
    await expect(page.locator(".settings-subnav")).toHaveCount(0);
    await expect(page.locator(".settings-detail")).toContainText("Use web search");
    await page.locator(".settings-nav").getByRole("button", { name: "Packages" }).click();
    await expect(page.locator(".settings-subnav")).toHaveCount(0);
    await expect(page.locator(".settings-detail")).toContainText("Pi Web Access");
    await page.locator(".settings-nav").getByRole("button", { name: "About" }).click();
    await expect(page.locator(".settings-subnav")).toHaveCount(0);
    await expect(page.locator(".settings-detail")).toContainText("Jasmine — The desktop app for Pi");
    await expect(page.locator(".settings-detail")).toContainText("independent, open-source desktop GUI for the Pi coding agent");
    await expect(page.locator(".settings-detail")).toContainText("not affiliated with or endorsed by Pi");
    await expect(page.locator(".settings-state-pill").first()).toHaveText(packageMetadata.version);
    await expect(page.locator(".settings-detail")).toContainText("Data location");
  });

  test("General language setting switches the shell between English and Chinese", async () => {
    const { page } = harness;
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const notepadPath = path.join(systemRoot, "System32", "notepad.exe");
    const powershellPath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const cmdPath = process.env.ComSpec || path.join(systemRoot, "System32", "cmd.exe");

    await startEmptyThread(page);
    await expect(page.locator(".empty-state h1")).toHaveText("Talk to yourself.");
    await openSettings(page);

    const editorRow = page.locator(".general-executable-row", { hasText: "Default editor" });
    const terminalRow = page.locator(".general-executable-row", { hasText: "Terminal shell" });
    const editorSelect = editorRow.locator('select[aria-label="Default text editor"]');
    const terminalSelect = terminalRow.locator('select[aria-label="Default terminal shell"]');
    await expect(editorSelect.locator("option").first()).toHaveText("Auto-detect (VS Code)");
    await expect(terminalSelect.locator("option").first()).toHaveText("Auto-detect (PowerShell)");
    expect(await editorSelect.locator("option").allTextContents()).toEqual(expect.arrayContaining(["Auto-detect (VS Code)", "Notepad"]));
    expect(await terminalSelect.locator("option").allTextContents()).toEqual(expect.arrayContaining(["Auto-detect (PowerShell)", "Command Prompt"]));
    await expect(editorRow.locator('output[aria-label="Default text editor path"]')).toHaveText(process.execPath);
    await expect(terminalRow.locator('output[aria-label="Default terminal shell path"]')).toHaveText(powershellPath);
    await expect(editorRow.locator('input[aria-label="Default text editor path"]')).toHaveCount(0);
    await expect(terminalRow.locator('input[aria-label="Default terminal shell path"]')).toHaveCount(0);
    await expect(editorRow.locator(".ui-settings-list-icon .icon")).toHaveCount(1);
    await expect(terminalRow.locator(".ui-settings-list-icon .icon")).toHaveCount(1);
    await expectExecutablePathMetadata(editorRow.locator('output[aria-label="Default text editor path"]'));
    await expectExecutablePathMetadata(terminalRow.locator('output[aria-label="Default terminal shell path"]'));
    const artifactTrackingSelect = page.locator('select[aria-label="Artifact file tracking mode"]');
    await expect(artifactTrackingSelect).toHaveValue("managed-tools-only");
    await expect(artifactTrackingSelect.locator('option[value="managed-tools-only"]')).toHaveText("Managed tools only (recommended)");
    await artifactTrackingSelect.selectOption("watcher");
    await editorSelect.selectOption(notepadPath);
    await terminalSelect.selectOption(cmdPath);
    await expect(editorRow.locator('output[aria-label="Default text editor path"]')).toHaveText(notepadPath);
    await expect(terminalRow.locator('output[aria-label="Default terminal shell path"]')).toHaveText(cmdPath);
    await saveSettings(page);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).skillEditorPath)).toBe(notepadPath);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).terminalShellPath)).toBe(cmdPath);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).fileChangeTrackingMode)).toBe("watcher");

    await editorRow.getByRole("button", { name: "Choose app..." }).click();
    await terminalRow.getByRole("button", { name: "Choose app..." }).click();
    await expect(editorRow.locator('output[aria-label="Default text editor path"]')).toHaveText(process.execPath);
    await expect(terminalRow.locator('output[aria-label="Default terminal shell path"]')).toHaveText(process.execPath);
    await saveSettings(page);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).skillEditorPath)).toBe(process.execPath);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).terminalShellPath)).toBe(process.execPath);
    await editorSelect.selectOption("");
    await terminalSelect.selectOption("");
    await expect(editorRow.locator('output[aria-label="Default text editor path"]')).toHaveText(process.execPath);
    await expect(terminalRow.locator('output[aria-label="Default terminal shell path"]')).toHaveText(powershellPath);

    const languageSelect = page.locator('.settings-detail select[aria-label="Interface language"]');
    await expect(languageSelect).toHaveValue("en");
    await languageSelect.selectOption("zh");
    await saveSettings(page);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).language)).toBe("zh");
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).skillEditorPath ?? "")).toBe("");
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).terminalShellPath ?? "")).toBe("");

    await expect(page.locator(".settings-nav")).toContainText("通用");
    await expect(page.locator(".settings-detail")).toContainText("语言");
    await expect(page.locator(".settings-detail")).toContainText("工具模型");

    await page.locator(".settings-nav").getByRole("button", { name: "服务商" }).click();
    const providerDetail = page.locator(".settings-detail");
    for (const providerName of ["DeepSeek", "Moonshot"]) {
      await page.locator(".settings-subnav").getByRole("button", { name: new RegExp(providerName) }).click();
      await expect(providerDetail.getByRole("region", { name: "服务商连接" })).toBeVisible();
      await expect(providerDetail).toContainText("默认模型");
      await expect(providerDetail).toContainText("上次检查");
      await expect(providerDetail.getByPlaceholder("搜索模型...")).toBeVisible();
      await expect(providerDetail.getByRole("button", { name: "测试" })).toBeVisible();
    }

    await providerDetail.locator(".model-options-button").first().click();
    await expect(page.locator(".model-dialog")).toContainText("模型能力");
    await expect(page.locator(".model-dialog")).toContainText("服务商选项（JSON）");
    await expect(page.locator(".model-dialog").getByRole("button", { name: "取消" })).toBeVisible();
    await page.locator(".model-dialog").getByRole("button", { name: "取消" }).click();

    await page.locator(".settings-nav").getByRole("button", { name: "通用" }).click();
    await expect(page.locator(".settings-detail")).toContainText("终端 Shell");
    await expect(page.locator('.settings-detail select[aria-label="界面语言"]')).toHaveValue("zh");
    await page.locator(".settings-nav").getByRole("button", { name: "关于" }).click();
    await expect(page.locator(".settings-detail")).toContainText("Jasmine — Pi 的桌面应用");
    await expect(page.locator(".settings-detail")).toContainText("面向 Pi coding agent 的独立开源桌面 GUI");
    await expect(page.locator(".settings-detail")).toContainText("与 Pi 官方无隶属或背书关系");
    await page.locator(".settings-window-control.close").click();
    await expect(page.locator(".settings-panel")).toBeHidden();
    await expect(page.locator(".empty-state h1")).toHaveText("\u8a00\u5df1");
    await expect(page.locator(".empty-state p")).toHaveText("\u6211\u89c1\u9752\u5c71\u591a\u59a9\u5a9a\uff0c\u6599\u9752\u5c71\u89c1\u6211\u5e94\u5982\u662f\u3002");
    await expect(page.locator(".rich-composer-editor")).toHaveAttribute("aria-placeholder", "\u5199\u70b9\u4ec0\u4e48\u3002\u4ec0\u4e48\u90fd\u53ef\u4ee5\u3002");
    await expect(page.getByRole("button", { name: "更多", exact: true })).toBeVisible();
  });

  test("settings layout remains usable at minimum window size", async () => {
    const { app, page } = harness;

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(920, 660);
    });
    await openProviderSettings(page);
    await expect(page.locator(".settings-panel")).toBeVisible();

    const panelBox = await page.locator(".settings-panel").boundingBox();
    const actionBoxes = await page.locator(".settings-actions button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
      })
    );

    expect(panelBox).not.toBeNull();
    for (const box of actionBoxes) {
      expect(box.width).toBeGreaterThan(40);
      expect(box.height).toBeGreaterThan(28);
      expect(box.right).toBeLessThanOrEqual((panelBox?.x ?? 0) + (panelBox?.width ?? 0) + 1);
      expect(box.bottom).toBeLessThanOrEqual((panelBox?.y ?? 0) + (panelBox?.height ?? 0) + 1);
    }
  });

  test("settings window has movable chrome plus minimize and restore states", async () => {
    const { page } = harness;

    await openProviderSettings(page);
    await expect(page.locator(".settings-panel")).toBeVisible();
    const before = await page.locator(".settings-panel").boundingBox();
    expect(before).not.toBeNull();

    const bar = page.locator(".settings-window-bar");
    const barBox = await bar.boundingBox();
    expect(barBox).not.toBeNull();
    await page.mouse.move((barBox?.x ?? 0) + 80, (barBox?.y ?? 0) + 12);
    await page.mouse.down();
    await page.mouse.move((barBox?.x ?? 0) + 160, (barBox?.y ?? 0) + 58);
    await page.mouse.up();

    const afterDrag = await page.locator(".settings-panel").boundingBox();
    expect(afterDrag).not.toBeNull();
    expect(Math.abs((afterDrag?.x ?? 0) - (before?.x ?? 0))).toBeGreaterThan(24);
    expect(Math.abs((afterDrag?.y ?? 0) - (before?.y ?? 0))).toBeGreaterThan(24);

    await page.getByRole("button", { name: "Minimize settings" }).click();
    await expect(page.locator(".settings-panel")).toHaveClass(/minimized/);
    await expect(page.locator(".settings-detail")).toHaveCount(0);
    await page.getByRole("button", { name: "Restore settings" }).click();
    await expect(page.locator(".settings-panel")).not.toHaveClass(/minimized/);

    await page.getByRole("button", { name: "Maximize settings" }).click();
    await expect(page.locator(".settings-panel")).toHaveClass(/maximized/);
    await expect(page.getByRole("button", { name: "Restore settings size" })).toBeVisible();
    await page.getByRole("button", { name: "Restore settings size" }).click();
    await expect(page.locator(".settings-panel")).not.toHaveClass(/maximized/);
  });
});
