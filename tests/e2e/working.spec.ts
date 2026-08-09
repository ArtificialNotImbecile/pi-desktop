import { expect, test } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { launchJasmine, navigationPath, openSettings, quitElectron, saveSettings, type HarnessApp } from "./helpers";

test.describe("Working task center", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("shows five concurrent chats across three projects and routes, stops, and cleans them up @smoke", async () => {
    const { page, userDataDir } = harness;
    const roots = [1, 2, 3].map((index) => path.join(userDataDir, `working-project-${index}`));
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
    const setup = await page.evaluate(async (projectRoots) => {
      const projects = [];
      for (const rootPath of projectRoots) {
        projects.push(await window.jasmine.createProjectFromPath({ path: rootPath }));
      }
      const prompts = [
        "working long response alpha",
        "working long response beta",
        "working wait for user gamma",
        "working failure delta",
        "working long response epsilon"
      ];
      const projectIds = [projects[0].id, projects[0].id, projects[1].id, projects[1].id, projects[2].id];
      const threads = [];
      for (let index = 0; index < prompts.length; index += 1) {
        threads.push(await window.jasmine.createThread({ title: `Working chat ${index + 1}`, projectId: projectIds[index] }));
      }
      return { projects, prompts, threads };
    }, roots);

    await page.getByRole("button", { name: /^Working/ }).click();
    await expect(page.locator(".working-page")).toBeVisible();
    await page.evaluate(({ prompts, threads }) => {
      const pending = prompts.map((content, index) => window.jasmine.sendChatMessage({
        requestId: `working-e2e-${index + 1}`,
        threadId: threads[index].id,
        content,
        messages: [],
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        toolsEnabled: true
      }).catch(() => null));
      (window as unknown as { __workingPending: unknown }).__workingPending = pending;
    }, setup);

    await expect(page.locator(".working-task")).toHaveCount(5, { timeout: 5_000 });
    await expect(page.locator(".working-group.attention .working-task")).toHaveCount(2);
    await expect(page.locator(".working-task.status-waiting_user")).toContainText("Waiting for your answer");
    await expect(page.locator(".working-task.status-failed")).toContainText("Failed");
    await expect(page.locator(".working-group:not(.attention) .working-task.status-running")).toHaveCount(3);
    await expect(page.locator(".sidebar-feature-row").filter({ hasText: "Working" })).toContainText("4");

    const waitingDialog = page.getByRole("dialog").filter({ hasText: "Should this Working task continue?" });
    await expect(waitingDialog).toBeVisible();
    await waitingDialog.getByRole("radio", { name: /Continue/ }).click();
    await waitingDialog.getByRole("button", { name: /Submit/ }).click();
    await expect(page.locator(".working-task.status-waiting_user")).toHaveCount(0, { timeout: 5_000 });

    const firstRunning = page.locator('.working-task[data-request-id="working-e2e-1"]');
    await firstRunning.getByRole("button", { name: "Stop" }).click();
    await expect(firstRunning).toHaveClass(/status-(stopping|cancelled)/);
    await expect(firstRunning).toHaveClass(/status-cancelled/, { timeout: 5_000 });

    const betaTask = page.locator('.working-task[data-request-id="working-e2e-2"]');
    await betaTask.locator(".working-task-main").click();
    await expect.poll(() => navigationPath(page)).toContain(setup.threads[1].id);

    await page.evaluate(async ({ threadId, projectId }) => {
      await window.jasmine.deleteThread(threadId);
      await window.jasmine.removeProject({ id: projectId });
    }, { threadId: setup.threads[3].id, projectId: setup.projects[2].id });
    await expect.poll(() => page.evaluate(async (requestId) => (await window.jasmine.getWorkingSnapshot()).items.some((item) => item.requestId === requestId), "working-e2e-4")).toBe(false);
    await expect.poll(() => page.evaluate(async (threadId) => (await window.jasmine.listThreads()).find((item) => item.id === threadId)?.projectId ?? null, setup.threads[4].id)).toBe(null);
  });

  test("persists notification preferences and restores the hidden window to the exact chat", async ({}, testInfo) => {
    let { page } = harness;

    await openSettings(page);
    await page.getByRole("combobox", { name: "Working task notification mode" }).selectOption("always");
    await page.getByRole("switch", { name: "Show Working task details in notifications" }).click();
    await saveSettings(page);
    await page.getByRole("button", { name: "Close settings" }).click();

    const task = await page.evaluate(async () => {
      const thread = await window.jasmine.createThread({ title: "Private notification chat" });
      return thread;
    });
    await page.getByRole("button", { name: /^Working/ }).click();
    await harness.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes("index.html"))?.hide();
      (globalThis as any).__jasmineWorkingNotifications?.clear?.();
    });
    await page.evaluate((threadId) => {
      void window.jasmine.sendChatMessage({
        requestId: "working-notification-e2e",
        threadId,
        content: "notification completion",
        messages: [],
        providerId: "deepseek",
        modelId: "deepseek-v4-flash"
      });
    }, task.id);

    await expect.poll(() => harness.app.evaluate(() => (globalThis as any).__jasmineWorkingNotifications?.list?.().length ?? 0)).toBe(1);
    const notification = await harness.app.evaluate(() => (globalThis as any).__jasmineWorkingNotifications.list()[0]);
    expect(notification.body).not.toContain("Private notification chat");
    await harness.app.evaluate(() => (globalThis as any).__jasmineWorkingNotifications.click(0));
    await expect.poll(() => harness.app.evaluate(() => Boolean((globalThis as any).__jasmineTray?.isMainVisible?.()))).toBe(true);
    await expect.poll(() => navigationPath(page)).toContain(task.id);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getWorkingSnapshot()).items.find((item) => item.requestId === "working-notification-e2e")?.unread)).toBe(false);

    const userDataDir = harness.userDataDir;
    await quitElectron(harness.app);
    harness = await launchJasmine(`${testInfo.title.replace(/\W+/g, "-")}-restart`, userDataDir);
    page = harness.page;
    await openSettings(page);
    await expect(page.getByRole("combobox", { name: "Working task notification mode" })).toHaveValue("always");
    await expect(page.getByRole("switch", { name: "Show Working task details in notifications" })).not.toBeChecked();
  });

  test("recovers an unfinished request as interrupted after restart", async ({}, testInfo) => {
    let { page } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Interrupted Working chat" }));
    await page.getByRole("button", { name: /^Working/ }).click();
    await page.evaluate((threadId) => {
      void window.jasmine.sendChatMessage({
        requestId: "working-interrupted-e2e",
        threadId,
        content: "working long response interrupted",
        messages: [],
        providerId: "deepseek",
        modelId: "deepseek-v4-flash"
      });
    }, thread.id);
    await expect(page.locator(".working-task.status-running")).toHaveCount(1);

    const userDataDir = harness.userDataDir;
    await quitElectron(harness.app);
    harness = await launchJasmine(`${testInfo.title.replace(/\W+/g, "-")}-restart`, userDataDir);
    page = harness.page;
    await page.getByRole("button", { name: /^Working/ }).click();
    await expect(page.locator(".working-task.status-interrupted")).toContainText("Interrupted when Jasmine exited");
  });
});
