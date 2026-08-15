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
    await expect(page.locator(".settings-nav button .icon")).toHaveCount(9);

    await page.locator(".settings-subnav button").first().click();
    await page.locator(".model-options-button").first().click();
    await expect(page.locator(".model-dialog")).toBeVisible();
    const dialogBox = await page.locator(".model-dialog").boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(dialogBox).not.toBeNull();
    expect(Math.abs(((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) / 2) - viewport.width / 2)).toBeLessThanOrEqual(12);
    expect(Math.abs(((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0) / 2) - viewport.height / 2)).toBeLessThanOrEqual(12);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".model-dialog")).toBeHidden();

    for (const mode of ["Env var", "Direct key"]) {
      await page.getByRole("group", { name: "API key input type" }).getByRole("button", { name: mode, exact: true }).click();
      const geometry = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll(".settings-row")).find((candidate) => candidate.querySelector(".api-key-control"));
        const copy = row?.querySelector(".ui-settings-row-copy") as HTMLElement | undefined;
        const control = row?.querySelector(".settings-row-actions") as HTMLElement | undefined;
        if (!copy || !control) return null;
        return { copy: copy.getBoundingClientRect().width, gap: control.getBoundingClientRect().left - copy.getBoundingClientRect().right };
      });
      expect(geometry).not.toBeNull();
      expect(geometry!.copy, `${mode} label column collapsed`).toBeGreaterThan(80);
      expect(geometry!.gap, `${mode} label overlaps its control`).toBeGreaterThanOrEqual(0);
    }
    const baseUrl = await page.locator("#provider-base-url").evaluate((node: HTMLInputElement) => ({
      truncated: node.scrollWidth > node.clientWidth,
      width: node.getBoundingClientRect().width
    }));
    expect(baseUrl.truncated).toBe(false);
    expect(baseUrl.width).toBeGreaterThan(200);
    // Use the real ProviderSettingsPanel -> App -> useProviders -> preload
    // path. Calling the bridge directly would miss a broken provider id or a
    // missing renderer state update while still making the model menu pass.
    await page.locator(".settings-subnav").getByRole("button", { name: /Moonshot|Kimi/ }).click();
    await page.getByRole("button", { name: "Fetch", exact: true }).click();
    await expect(page.locator(".model-list")).toContainText("kimi-k2.24");
    await page.getByRole("button", { name: "Close settings" }).click();

    await page.locator(".model-pill").click();
    const menu = page.locator(".model-menu");
    await expect(menu).toBeVisible();

    const boundedMenuBox = await menu.boundingBox();
    const menuViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(boundedMenuBox).not.toBeNull();
    expect(menuViewport).not.toBeNull();
    expect((boundedMenuBox?.y ?? 0) + (boundedMenuBox?.height ?? 0)).toBeLessThanOrEqual(menuViewport.height - 4);
    expect(boundedMenuBox?.height ?? 0).toBeGreaterThan(170);

    const modelList = page.locator(".model-menu-models");
    await expect.poll(() => modelList.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await expect(page.locator(".model-menu-actions")).toBeVisible();
    await modelList.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(menu.getByRole("button", { name: /kimi-k2\.24/ })).toBeVisible();
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

    // Direct keys and environment references share the form, but resolve
    // through different main-process secret paths. Exercise both without a
    // second Electron launch.
    await page.getByRole("button", { name: "Env var" }).click();
    await page.locator("#provider-api-key-ref").fill("DEEPSEEK_API_KEY");
    await saveProvider(page);
    await expect.poll(() => page.evaluate(async () => {
      const provider = (await window.jasmine.listProviders()).find((item) => item.id === "deepseek");
      return provider?.apiKeyRef ?? "";
    })).toBe("env:DEEPSEEK_API_KEY");
    await testProvider(page);
  });

  test("model labels stay bound while the composer switches models @smoke", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("slow response slow timeline model label");
    await page.getByRole("button", { name: "Send" }).click();
    const liveAssistant = page.locator(".assistant-block.live-message").last();
    await expect(liveAssistant).toBeVisible();
    await expect(page.locator(".run-header.live")).toContainText("deepseek-v4-flash");
    await expect(liveAssistant.locator(".message-actions")).toBeHidden();
    await expect(liveAssistant.locator(".message-actions")).toHaveCSS("pointer-events", "none");
    await expect(liveAssistant.locator(".thinking-item")).toContainText("Need to inspect");
    await expect(liveAssistant.locator(".timeline-row-thought")).toHaveCount(0);
    await expect(liveAssistant.locator(".tool-run-item").first()).toHaveClass(/running/);

    // Switch the composer model while the slow response is still streaming.
    // Asserting on the live row after waiting for the final chunk raced run
    // settlement, so the switch happens mid-stream instead.
    await page.locator(".model-pill").click();
    await page.locator(".model-provider-group", { hasText: "Moonshot Kimi" }).getByRole("button", { name: /kimi-k2\.6/ }).click();
    await expect(page.locator(".model-pill")).toContainText("kimi-k2.6");
    await expect(page.locator(".run-header.live")).toContainText("deepseek-v4-flash");

    await expect(page.locator(".assistant-block").last()).toContainText("Slow response complete.", { timeout: 10_000 });
    await expect(page.locator(".assistant-block").last().locator(".run-header-meta")).toContainText("deepseek-v4-flash");

    await page.locator(".rich-composer-editor").fill("provider switch history label");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".assistant-block").first().locator(".run-header-meta")).toContainText("deepseek-v4-flash");
    await expect(page.locator(".assistant-block").last().locator(".run-header-meta")).toContainText("kimi-k2.6");
  });
});
