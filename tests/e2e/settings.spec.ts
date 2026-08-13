import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  baseLaunchEnv,
  clickCenter,
  createExternalSkillFixture,
  createPiPluginFixture,
  createProjectFolderFixture,
  createPromptTemplateFixture,
  createRedSquarePng,
  executableFixtures,
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

test.describe("Jasmine settings", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
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

  test("settings panel keeps its navigation and chrome usable when moved or resized", async () => {
    const { page } = harness;

    // macOS hosted runners can clamp a newly created 1200px BrowserWindow to
    // their 1024px display, which activates the responsive left/top !important
    // rules and correctly prevents free dragging. Normalize the renderer
    // viewport explicitly so this assertion always exercises the desktop CSS.
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1200);
    await openSettings(page);
    await expect(page.locator(".settings-nav")).toHaveCSS("user-select", "none");
    await page.locator(".settings-detail").click({ position: { x: 12, y: 12 } });
    await page.keyboard.press("Control+A");
    const selectedSettingsText = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selectedSettingsText).not.toContain("Prompt Templates");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(page.locator(".settings-panel")).toHaveClass(/single-nav/);
    await expect(page.locator(".settings-subnav")).toHaveCount(0);
    await expect(page.locator(".settings-nav button .icon")).toHaveCount(9);
    await expect(page.locator(".settings-detail")).not.toContainText("Command palette");
    await expect(page.locator(".settings-detail")).not.toContainText("Theme");
    await expect(page.locator(".settings-detail .settings-header")).toHaveCount(0);

    // The form/payload behavior lives in renderer tests. Retain the App-level
    // settings -> theme hook binding so a saved appearance cannot stop applying
    // while the component tests remain green.
    await page.locator(".settings-nav").getByRole("button", { name: "Appearance" }).click();
    await page.locator(".appearance-presets").getByRole("button", { name: /Jasmine/ }).click();
    await saveSettings(page);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#0b74de");

    // The renderer test owns the pointer arithmetic and state guards. Keep one
    // real-layout assertion here so a CSS regression that stops honoring the
    // resulting left/top values cannot leave the replacement test green.
    const panel = page.locator(".settings-panel");
    const before = await panel.boundingBox();
    const barBox = await page.locator(".settings-window-bar").boundingBox();
    if (!before || !barBox) throw new Error("Settings geometry is missing.");
    await page.mouse.move(barBox.x + 80, barBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(barBox.x + 120, barBox.y + 42);
    await page.mouse.up();

    const after = await panel.boundingBox();
    if (!after) throw new Error("Settings panel disappeared after dragging.");
    expect(Math.abs(after.x - before.x)).toBeGreaterThan(24);
    expect(Math.abs(after.y - before.y)).toBeGreaterThan(24);

    // Reuse this launch for the <=1040 responsive layout after the real
    // desktop-breakpoint left/top assertion has already run.
    await page.locator(".settings-nav").getByRole("button", { name: "Providers" }).click();
    await page.setViewportSize({ width: 920, height: 660 });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(920);
    const panelBox = await panel.boundingBox();
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

  test("General language setting switches the shell between English and Chinese", async () => {
    const { page } = harness;
    // Same fixture the harness seeds discovery with, so these assertions stay
    // true on every platform instead of hardcoding one OS's shell paths.
    const [autoEditor, altEditor] = executableFixtures.editors;
    const [autoTerminal, altTerminal] = executableFixtures.terminals;

    await startEmptyThread(page);
    await expect(page.locator(".empty-state h1")).toHaveText("Talk to yourself.");
    await openSettings(page);

    const editorRow = page.locator(".general-executable-row", { hasText: "Default editor" });
    const terminalRow = page.locator(".general-executable-row", { hasText: "Terminal shell" });
    const editorSelect = editorRow.locator('select[aria-label="Default text editor"]');
    const terminalSelect = terminalRow.locator('select[aria-label="Default terminal shell"]');
    await expect(editorSelect.locator("option").first()).toHaveText(`Auto-detect (${autoEditor.label})`);
    await expect(terminalSelect.locator("option").first()).toHaveText(`Auto-detect (${autoTerminal.label})`);
    expect(await editorSelect.locator("option").allTextContents()).toEqual(expect.arrayContaining([`Auto-detect (${autoEditor.label})`, altEditor.label]));
    expect(await terminalSelect.locator("option").allTextContents()).toEqual(expect.arrayContaining([`Auto-detect (${autoTerminal.label})`, altTerminal.label]));
    await expect(editorRow.locator('output[aria-label="Default text editor path"]')).toHaveText(process.execPath);
    await expect(terminalRow.locator('output[aria-label="Default terminal shell path"]')).toHaveText(autoTerminal.command);
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
    await editorSelect.selectOption(altEditor.command);
    await terminalSelect.selectOption(altTerminal.command);
    await expect(editorRow.locator('output[aria-label="Default text editor path"]')).toHaveText(altEditor.command);
    await expect(terminalRow.locator('output[aria-label="Default terminal shell path"]')).toHaveText(altTerminal.command);
    await saveSettings(page);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).skillEditorPath)).toBe(altEditor.command);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).terminalShellPath)).toBe(altTerminal.command);
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
    await expect(terminalRow.locator('output[aria-label="Default terminal shell path"]')).toHaveText(autoTerminal.command);

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
    await expect(page.locator(".right-panel-tabs")).toHaveAttribute("aria-label", "右侧面板快捷方式");
    await page.getByRole("button", { name: "打开上下文分类" }).click();
    await expect(page.getByRole("complementary", { name: "上下文分类" })).toBeVisible();
    await expect(page.getByRole("separator", { name: "调整右侧面板宽度" })).toBeVisible();
    await expect(page.getByRole("button", { name: "收起面板" })).toBeVisible();
    await page.getByRole("button", { name: "打开终端" }).click();
    await expect(page.locator(".terminal-meta button")).toHaveText(/启动|停止/);
    await expect(page.locator(".settings-panel")).toBeHidden();
    await expect(page.locator(".empty-state h1")).toHaveText("\u8a00\u5df1");
    await expect(page.locator(".empty-state p")).toHaveText("\u6211\u89c1\u9752\u5c71\u591a\u59a9\u5a9a\uff0c\u6599\u9752\u5c71\u89c1\u6211\u5e94\u5982\u662f\u3002");
    await expect(page.locator(".rich-composer-editor")).toHaveAttribute("aria-placeholder", "\u5199\u70b9\u4ec0\u4e48\u3002\u4ec0\u4e48\u90fd\u53ef\u4ee5\u3002");
    await expect(page.getByRole("button", { name: "更多", exact: true })).toBeVisible();
  });

});
