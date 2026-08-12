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

test.describe("Jasmine providers and models", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("settings hierarchy, model menu, and model options are navigable", async () => {
    const { page } = harness;

    await expect(page.locator(".model-pill")).toContainText("off");
    await page.locator(".model-pill").click();
    await expect(page.locator(".model-menu")).toBeVisible();
    await expect(page.locator(".model-menu")).not.toContainText("Connected");
    await expect(page.locator(".model-menu")).not.toContainText("Models");
    const menuBox = await page.locator(".model-menu").boundingBox();
    expect(menuBox?.width ?? 0).toBeGreaterThanOrEqual(220);
    expect(menuBox?.width ?? 999).toBeLessThanOrEqual(270);
    const activeModelRow = page.locator(".model-provider-group button.active").first();
    await expect(activeModelRow.locator(".icon")).toHaveCount(1);
    await expect(activeModelRow).toBeVisible();
    await expect(page.locator(".model-menu-actions")).toContainText("Reasoning effort");
    await expect(page.locator(".model-menu-actions").getByRole("button", { name: "high", exact: true })).toBeVisible();
    await page.locator(".model-menu-actions").getByRole("button", { name: "medium" }).click();
    await expect(page.locator(".model-pill")).toContainText("medium");

    await openSettings(page, "Providers");
    await expect(page.locator(".settings-panel")).toHaveClass(/has-subnav/);
    await expect(page.locator(".settings-subnav")).toBeVisible();
    await expect(page.locator(".settings-nav button .icon")).toHaveCount(10);

    await page.locator(".settings-subnav button").first().click();
    await page.locator(".model-options-button").first().click();
    await expect(page.locator(".model-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".model-dialog")).toBeHidden();
  });

  test("model menu stays bounded and scrollable with many models", async () => {
    const { page } = harness;

    await page.evaluate(async () => {
      await window.jasmine.fetchProviderModels("moonshot");
    });
    await page.reload();

    await page.locator(".model-pill").click();
    const menu = page.locator(".model-menu");
    await expect(menu).toBeVisible();

    const menuBox = await menu.boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(menuBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height - 4);
    expect(menuBox?.height ?? 0).toBeGreaterThan(170);

    const modelList = page.locator(".model-menu-models");
    await expect.poll(() => modelList.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await expect(page.locator(".model-menu-actions")).toBeVisible();
    await modelList.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(menu.getByRole("button", { name: /kimi-k2\.24/ })).toBeVisible();
  });

  test("provider enabled toggle responds to pointer and keyboard", async () => {
    const { page } = harness;

    await openProviderSettings(page);
    await expect(page.locator(".settings-panel")).toBeVisible();
    await expect(page.locator(".settings-actions button.primary")).toHaveText("Saved");
    await expect(page.locator(".settings-actions button.primary")).toBeDisabled();

    const providerEnabledSwitch = page.getByRole("switch", { name: "Provider enabled" });
    await page.getByText("Enabled", { exact: true }).click();
    await expect(providerEnabledSwitch.locator(".ui-switch-label")).toHaveCount(0);
    await expect(providerEnabledSwitch).toHaveAttribute("aria-checked", "true");
    await providerEnabledSwitch.focus();
    await page.keyboard.press("Space");
    await expect(providerEnabledSwitch).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Space");
    await expect(providerEnabledSwitch).toHaveAttribute("aria-checked", "true");
  });

  test("provider saves env-var key and tests the connection", async () => {
    const { page } = harness;

    await openProviderSettings(page);
    await page.locator("#provider-base-url").fill("https://api.deepseek.com/v1");
    await expect(page.getByRole("group", { name: "API key input type" }).getByRole("button", { name: "Env var" })).toHaveClass(/active/);
    await page.locator("#provider-api-key-ref").fill("DEEPSEEK_API_KEY");
    await saveProvider(page);
    await testProvider(page);
  });

  test("provider rows keep their label column and fill their control column in both API key modes", async () => {
    const { page } = harness;

    await openProviderSettings(page);
    for (const mode of ["Env var", "Direct key"]) {
      await page.getByRole("group", { name: "API key input type" }).getByRole("button", { name: mode, exact: true }).click();
      const geometry = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll(".settings-row")).find((candidate) => candidate.querySelector(".api-key-control"));
        const copy = row?.querySelector(".ui-settings-row-copy") as HTMLElement | undefined;
        const control = row?.querySelector(".settings-row-actions") as HTMLElement | undefined;
        if (!copy || !control) return null;
        return { copy: copy.getBoundingClientRect().width, gap: control.getBoundingClientRect().left - copy.getBoundingClientRect().right };
      });
      // The control column used to size to its content, and the longer Direct key
      // hint then took the whole row: the label column collapsed to 0 and spilled
      // its description across the control.
      expect(geometry).not.toBeNull();
      expect(geometry!.copy, `${mode} label column collapsed`).toBeGreaterThan(80);
      expect(geometry!.gap, `${mode} label overlaps its control`).toBeGreaterThanOrEqual(0);
    }

    // A content-sized column also left inputs at the width an input asks for by
    // default, which truncated the base URL.
    const baseUrl = await page.locator("#provider-base-url").evaluate((node: HTMLInputElement) => ({
      truncated: node.scrollWidth > node.clientWidth,
      width: node.getBoundingClientRect().width
    }));
    expect(baseUrl.truncated).toBe(false);
    expect(baseUrl.width).toBeGreaterThan(200);
  });

  test("provider direct key saves masked and persists", async () => {
    const { page } = harness;

    await openProviderSettings(page);
    await page.locator("#provider-base-url").fill("https://api.deepseek.com/v1");
    await page.getByRole("button", { name: "Direct key" }).click();
    await page.locator("#provider-api-key-direct").fill("jasmine-direct-secret-1234");
    await expect(page.locator("#provider-api-key-direct")).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show API key" }).click();
    await expect(page.locator("#provider-api-key-direct")).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide API key" }).click();
    await expect(page.locator("#provider-api-key-direct")).toHaveAttribute("type", "password");
    await saveProvider(page);
    await expect(page.locator("#provider-api-key-direct")).toHaveValue("");
    await expect(page.locator("#provider-api-key-direct")).toHaveAttribute("placeholder", "Saved \u2022\u2022\u2022\u20221234");
    await expect(page.locator(".settings-actions button.primary")).toBeDisabled();
    await expect.poll(() => page.evaluate(async () => {
      const provider = (await window.jasmine.listProviders()).find((item) => item.id === "deepseek");
      return provider?.apiKeyRef ?? "";
    })).toBe("key:\u2022\u2022\u2022\u20221234");
    await testProvider(page);
  });

  test("provider fetch models populates the default model", async () => {
    const { page } = harness;

    await openProviderSettings(page);
    await page.locator(".models-header").getByRole("button", { name: "Fetch" }).click();
    await expect(page.locator(".model-list .model-row")).toHaveCount(2);
    await expect(page.locator("#provider-default-model")).toContainText("deepseek-v4-pro");
    await expect(page.locator(".model-search input")).toBeVisible();
  });

  test("switch provider/model from compact menu and send through selected model @smoke", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".model-pill").click();
    await page.locator(".model-provider-group", { hasText: "Moonshot Kimi" }).getByRole("button", { name: /kimi-k2\.6/ }).click();
    await expect(page.locator(".model-pill")).toContainText("kimi-k2.6");

    await page.locator(".rich-composer-editor").fill("provider switch check");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".assistant-block").last().locator(".message-run-line")).toContainText("kimi-k2.6");
  });

  test("assistant model labels stay bound to the model used for each response", async () => {
    const { page } = harness;

    await expect(page.locator(".assistant-block").first().locator(".message-run-line")).toContainText("deepseek-v4-flash");
    await page.locator(".model-pill").click();
    await page.locator(".model-provider-group", { hasText: "Moonshot Kimi" }).getByRole("button", { name: /kimi-k2\.6/ }).click();
    await expect(page.locator(".model-pill")).toContainText("kimi-k2.6");
    await expect(page.locator(".assistant-block").first().locator(".message-run-line")).toContainText("deepseek-v4-flash");

    await page.locator(".rich-composer-editor").fill("provider switch history label");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".assistant-block").first().locator(".message-run-line")).toContainText("deepseek-v4-flash");
    await expect(page.locator(".assistant-block").last().locator(".message-run-line")).toContainText("kimi-k2.6");
  });

  test("running response model label stays bound while composer model changes", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("slow response slow timeline model label");
    await page.getByRole("button", { name: "Send" }).click();
    const liveAssistant = page.locator(".assistant-block.live-message").last();
    await expect(liveAssistant).toBeVisible();
    await expect(liveAssistant.locator(".message-run-line")).toContainText("deepseek-v4-flash");
    await expect(page.locator(".message-actions")).toHaveCount(0);
    await expect(liveAssistant.locator(".thinking-markdown")).toContainText("Need to inspect");
    await expect(liveAssistant.locator(".tool-run-item").first()).toContainText("reading");

    // Switch the composer model while the slow response is still streaming.
    // Asserting on the live row after waiting for the final chunk raced run
    // settlement, so the switch happens mid-stream instead.
    await page.locator(".model-pill").click();
    await page.locator(".model-provider-group", { hasText: "Moonshot Kimi" }).getByRole("button", { name: /kimi-k2\.6/ }).click();
    await expect(page.locator(".model-pill")).toContainText("kimi-k2.6");
    await expect(liveAssistant.locator(".message-run-line")).toContainText("deepseek-v4-flash");

    await expect(page.locator(".assistant-block").last()).toContainText("Slow response complete.", { timeout: 10_000 });
    await expect(page.locator(".assistant-block").last().locator(".message-run-line")).toContainText("deepseek-v4-flash");
  });

  test("providers section shows the configured provider card", async () => {
    const { page } = harness;

    await openSettings(page, "Providers");
    await expect(page.locator(".settings-panel")).toHaveClass(/has-subnav/);
    await expect(page.locator(".settings-detail .settings-header")).toHaveCount(0);
    await expect(page.locator(".provider-card h3")).toHaveText("DeepSeek");
    await expect(page.locator(".settings-detail")).not.toContainText("Configure the model backend used by Jasmine chat");
  });

  test("model options validates provider JSON inline", async () => {
    const { page } = harness;

    await openProviderSettings(page);
    const firstModelOptions = page.locator(".model-options-button").first();
    await firstModelOptions.click();
    const dialogBox = await page.locator(".model-dialog").boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(dialogBox).not.toBeNull();
    expect(Math.abs(((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) / 2) - viewport.width / 2)).toBeLessThanOrEqual(12);
    expect(Math.abs(((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0) / 2) - viewport.height / 2)).toBeLessThanOrEqual(12);

    const jsonField = page.locator(".provider-json-field textarea");
    await jsonField.fill("{ invalid");
    await page.locator(".model-dialog-actions").getByRole("button", { name: "Save" }).click();

    await expect(page.locator("#provider-options-error")).toHaveText("Provider options must be valid JSON.");
    await expect(page.locator(".model-dialog")).toBeVisible();
    await expect(jsonField).toHaveAttribute("aria-invalid", "true");
  });
});
