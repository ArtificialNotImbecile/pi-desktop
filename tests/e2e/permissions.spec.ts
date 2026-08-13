import { expect, test, type Page } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  launchJasmine,
  navigationPath,
  quitElectron,
  rootDir,
  startEmptyThread,
  type HarnessApp,
  waitForStableAssistant
} from "./helpers";

test.describe("Jasmine permission approvals", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("ask mode denies, allows once, and scopes project writes @smoke", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).permissionMode)).toBe("ask");
    await expect(page.getByRole("button", { name: "Permission mode" })).toContainText("Ask for approval");
    const screenshotDir = path.join(rootDir, "test-results", "ui-harness", "e2e");
    await mkdir(screenshotDir, { recursive: true });
    await page.getByRole("button", { name: "Permission mode" }).click();
    await expect(page.locator(".permission-mode-menu")).toBeVisible();
    await page.screenshot({ path: path.join(screenshotDir, "permission-mode-menu.png") });
    await page.keyboard.press("Escape");

    await sendPermissionFixture(page, "permission approval fixture bash deny");
    const firstPrompt = page.getByRole("dialog", { name: "Permission required" });
    await expect(firstPrompt).toContainText("echo jasmine-permission-fixture");
    await page.screenshot({ path: path.join(screenshotDir, "permission-approval-dialog.png") });
    await expect(firstPrompt).toContainText("The agent wants to run a shell command.");
    await page.keyboard.press("Escape");
    await expect(firstPrompt).toBeVisible();
    await firstPrompt.getByRole("button", { name: "Deny" }).click();
    await waitForStableAssistant(page, "Permission denied for the fixture.");

    await sendPermissionFixture(page, "permission approval fixture bash allow");
    const secondPrompt = page.getByRole("dialog", { name: "Permission required" });
    await expect(secondPrompt).toContainText("Allow once applies only to this exact tool call.");
    await secondPrompt.getByRole("button", { name: "Allow once" }).click();
    await waitForStableAssistant(page, "Permission approved once for the fixture.");
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).permissionMode)).toBe("ask");
    await expect(page.getByRole("dialog", { name: "Permission required" })).toHaveCount(0);

    await page.getByRole("button", { name: "Open Folder..." }).first().click();
    const project = await page.evaluate(async () => {
      const candidate = (await window.jasmine.listProjects()).find((item) => item.name === "local-project");
      if (!candidate) throw new Error("Permission project fixture was not created.");
      return candidate;
    });
    const projectRow = page.locator(".project-row", { hasText: "local-project" }).first();
    await projectRow.getByRole("button", { name: "New chat in local-project" }).click();
    await expect.poll(() => navigationPath(page)).toContain(`/projects/${encodeURIComponent(project.id)}/chat/`);

    await sendPermissionFixture(page, "permission approval fixture write inside");
    await waitForStableAssistant(page, "The project-scoped write fixture was allowed without an approval prompt.");
    await expect(page.getByRole("dialog", { name: "Permission required" })).toHaveCount(0);

    await sendPermissionFixture(page, "permission approval fixture write outside");
    const outsidePrompt = page.getByRole("dialog", { name: "Permission required" });
    await expect(outsidePrompt).toContainText("outside the current project");
    await expect(outsidePrompt).toContainText(project.rootPath);
    await expect(outsidePrompt).toContainText("../outside.txt");
    await outsidePrompt.getByRole("button", { name: "Deny" }).click();
    await waitForStableAssistant(page, "Permission denied for the fixture.");

    await page.getByRole("button", { name: "New chat in Chats" }).click();
    await expect.poll(() => navigationPath(page)).toMatch(/^\/chats\//);
    await sendPermissionFixture(page, "permission approval fixture write inside without project");
    const noProjectPrompt = page.getByRole("dialog", { name: "Permission required" });
    await expect(noProjectPrompt).toContainText("No project is open, so every file change needs approval.");
    await expect(noProjectPrompt).not.toContainText(project.rootPath);
    await noProjectPrompt.getByRole("button", { name: "Deny" }).click();
    await waitForStableAssistant(page, "Permission denied for the fixture.");
  });

  test("full access persists across restart and bypasses approval", async () => {
    let { page } = harness;
    await startEmptyThread(page);

    await page.getByRole("button", { name: "Permission mode" }).click();
    await page.locator(".permission-mode-item.full-access").click();
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).permissionMode)).toBe("full-access");
    await expect(page.getByRole("button", { name: "Permission mode" })).toContainText("Full access");

    const userDataDir = harness.userDataDir;
    await quitElectron(harness.app);
    harness = await launchJasmine("permission-full-access-restart", userDataDir);
    page = harness.page;

    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppSettings()).permissionMode)).toBe("full-access");
    await expect(page.getByRole("button", { name: "Permission mode" })).toContainText("Full access");
    await sendPermissionFixture(page, "permission approval fixture bash full access");
    await waitForStableAssistant(page, "Full access allowed the fixture without an approval prompt.");
    await expect(page.getByRole("dialog", { name: "Permission required" })).toHaveCount(0);
  });

  test("a different renderer cannot approve and reload or cancellation never falls through", async () => {
    const { app, page } = harness;
    await startEmptyThread(page);
    await capturePermissionPrompts(page);

    await sendPermissionFixture(page, "permission approval fixture sender binding");
    await expect.poll(() => readCapturedPromptId(page)).not.toBe("");
    const promptId = await readCapturedPromptId(page);
    const attackerWindow = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }, preloadPath) => {
      const win = new BrowserWindow({
        show: false,
        x: -10_000,
        y: -10_000,
        opacity: 0,
        focusable: false,
        skipTaskbar: true,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      });
      void win.loadURL("data:text/html,<title>permission sender fixture</title>");
    }, path.join(rootDir, "src", "main", "preload.cjs"));
    const attacker = await attackerWindow;
    await attacker.waitForLoadState("domcontentloaded");

    const attackerResult = await attacker.evaluate(async (id) => {
      try {
        await window.jasmine.answerPermissionApproval({ id, decision: "allow-once" });
        return "unexpectedly allowed";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, promptId);
    expect(attackerResult).toContain("different Jasmine window");
    await expect(page.getByRole("dialog", { name: "Permission required" })).toBeVisible();
    await page.getByRole("dialog", { name: "Permission required" }).getByRole("button", { name: "Allow once" }).click();
    await waitForStableAssistant(page, "Permission approved once for the fixture.");
    await attacker.close();

    await startEmptyThread(page);
    await sendPermissionFixture(page, "permission approval fixture cancellation");
    await expect(page.getByRole("dialog", { name: "Permission required" })).toBeVisible();
    const stopped = await page.evaluate(async () => {
      const task = (await window.jasmine.getWorkingSnapshot()).items.find((item) => item.status === "waiting_user");
      return task ? window.jasmine.stopWorkingTask(task.requestId) : false;
    });
    expect(stopped).toBe(true);
    await expect(page.getByRole("dialog", { name: "Permission required" })).toHaveCount(0);
    await expect(page.locator(".message-stack")).not.toContainText("Permission approved once for the fixture.", { timeout: 1_000 });
    await expect(page.locator(".error-strip")).toBeHidden();
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getWorkingSnapshot()).items.some((item) => item.status === "waiting_user"))).toBe(false);

    await startEmptyThread(page);
    await sendPermissionFixture(page, "permission approval fixture renderer reload");
    await expect(page.getByRole("dialog", { name: "Permission required" })).toBeVisible();
    const rendererReloadThreadId = await page.evaluate(async () => {
      for (const thread of await window.jasmine.listThreads()) {
        const messages = await window.jasmine.listMessages(thread.id);
        if (messages.some((message) => message.role === "user" && message.content === "permission approval fixture renderer reload")) {
          return thread.id;
        }
      }
      throw new Error("Renderer-reload permission thread was not persisted.");
    });
    await page.reload();
    await page.waitForSelector(".app-shell");
    await expect(page.getByRole("dialog", { name: "Permission required" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(async (threadId) => {
      const messages = await window.jasmine.listMessages(threadId);
      const task = (await window.jasmine.getWorkingSnapshot()).items.find((item) => item.threadId === threadId);
      return {
        approved: messages.some((message) => message.role === "assistant" && message.content.includes("Permission approved")),
        status: task?.status ?? "missing"
      };
    }, rendererReloadThreadId)).toEqual({ approved: false, status: "failed" });
  });
});

async function sendPermissionFixture(page: Page, text: string): Promise<void> {
  await page.locator(".rich-composer-editor").fill(text);
  await page.locator('.send-button[aria-label="Send"]').click();
}

async function capturePermissionPrompts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = globalThis as typeof globalThis & { __permissionPromptIds?: string[] };
    state.__permissionPromptIds = [];
    window.jasmine.onPermissionApproval((prompt) => {
      state.__permissionPromptIds?.push(prompt.id);
    });
  });
}

async function readCapturedPromptId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = globalThis as typeof globalThis & { __permissionPromptIds?: string[] };
    return state.__permissionPromptIds?.at(-1) ?? "";
  });
}
