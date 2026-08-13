import { expect, test } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { launchJasmine, navigationPath, openSettings, quitElectron, rootDir, saveSettings, type HarnessApp } from "./helpers";

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
        "show file changes working failure delta",
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
    await expect.poll(() => page.evaluate(async (threadId) => (
      await window.jasmine.listThreadArtifacts(threadId)
    ).captures.length, setup.threads[3].id)).toBe(1);
    const failedRunEvidence = await page.evaluate(async (threadId) => ({
      artifacts: await window.jasmine.listThreadArtifacts(threadId),
      messages: await window.jasmine.listMessages(threadId)
    }), setup.threads[3].id);
    expect(failedRunEvidence.artifacts.captures[0].changes.map((change) => change.status).sort()).toEqual(["added", "deleted", "modified"]);
    expect(failedRunEvidence.artifacts.captures[0].messageId).toBeUndefined();
    expect(failedRunEvidence.messages.some((message) => message.content.includes("filesystem changes were captured"))).toBe(false);
    await expect(page.locator(".working-group:not(.attention) .working-task.status-running")).toHaveCount(3);
    await expect(page.locator(".sidebar-feature-row").filter({ hasText: "Working" })).toContainText("4");
    await expect(page.locator(".working-headline")).toContainText("need you");
    // Nothing has finished yet, so the Done group renders nothing at all rather
    // than a placeholder telling you so.
    await expect(page.locator(".working-group")).toHaveCount(2);
    await expect(page.locator(".working-group-empty")).toHaveCount(0);

    const taskGeometry = await page.locator(".working-task").evaluateAll((rows) => rows.map((row) => {
      const card = row.getBoundingClientRect();
      const content = Array.from(row.querySelectorAll<HTMLElement>(".working-task-main, .working-task-copy, .working-task-activity, .working-task-aside, .working-stop"));
      return {
        height: card.height,
        content: content.map((item) => {
          const box = item.getBoundingClientRect();
          return { top: box.top, right: box.right, bottom: box.bottom, left: box.left };
        }),
        card: { top: card.top, right: card.right, bottom: card.bottom, left: card.left }
      };
    }));
    for (const task of taskGeometry) {
      expect(task.height).toBeGreaterThanOrEqual(48);
      for (const box of task.content) {
        expect(box.top).toBeGreaterThanOrEqual(task.card.top - 1);
        expect(box.left).toBeGreaterThanOrEqual(task.card.left - 1);
        expect(box.right).toBeLessThanOrEqual(task.card.right + 1);
        expect(box.bottom).toBeLessThanOrEqual(task.card.bottom + 1);
      }
    }
    // A task that stops to ask a question keeps whatever was queued behind it,
    // but the Running filter cannot show that task, so its tile must not
    // advertise the queue.
    await page.evaluate((threadId) => window.jasmine.queueChatMessage({
      requestId: "working-e2e-3",
      threadId,
      mode: "followUp",
      content: "queued behind the question",
      attachments: []
    }), setup.threads[2].id);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getWorkingSnapshot()).items
      .find((item) => item.requestId === "working-e2e-3")?.queueCount)).toBe(1);
    await expect(page.locator(".working-tile").filter({ hasText: "Running" })).toContainText("No queued messages");

    const waitingDialog = page.getByRole("dialog").filter({ hasText: "Should this Working task continue?" });
    await expect(waitingDialog).toBeVisible();
    await waitingDialog.getByRole("radio", { name: /Continue/ }).click();
    await waitingDialog.getByRole("button", { name: /Submit/ }).click();
    await expect(page.locator(".working-task.status-waiting_user")).toHaveCount(0, { timeout: 5_000 });

    // The summary counts are the filter: pressing one narrows the list to those
    // tasks, pressing it again restores the whole inbox.
    const attentionTile = page.getByRole("button", { name: /Needs you/ });
    await attentionTile.click();
    await expect(attentionTile).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".working-group")).toHaveCount(1);
    await expect(page.locator(".working-task")).toHaveCount(1);
    await expect(page.locator(".working-task.status-failed")).toHaveCount(1);
    await attentionTile.click();
    await expect(page.locator(".working-task")).toHaveCount(5);

    // With more finished runs than the Done group shows at once, the heading has
    // to keep reporting the total -- the tile and the Show all label do -- while
    // only the rows on screen are capped.
    await page.evaluate(async () => {
      for (let index = 0; index < 6; index += 1) {
        const thread = await window.jasmine.createThread({ title: `Finished Working chat ${index + 1}` });
        await window.jasmine.sendChatMessage({
          requestId: `working-done-e2e-${index + 1}`,
          threadId: thread.id,
          content: "working done filler",
          messages: [],
          providerId: "deepseek",
          modelId: "deepseek-v4-flash"
        });
      }
    });
    const doneTotal = await page.evaluate(async () => (await window.jasmine.getWorkingSnapshot()).items
      .filter((item) => ["completed", "cancelled", "interrupted"].includes(item.status)).length);
    expect(doneTotal).toBeGreaterThan(5);
    const doneGroup = page.locator('[data-working-group="done"]');
    await expect(doneGroup.locator(".working-group-heading > span")).toHaveText(String(doneTotal));
    await expect(doneGroup.locator(".working-task")).toHaveCount(5);
    await doneGroup.getByRole("button", { name: /Show all/ }).click();
    await expect(doneGroup.locator(".working-task")).toHaveCount(doneTotal);
    await doneGroup.getByRole("button", { name: "Show less" }).click();
    await expect(doneGroup.locator(".working-task")).toHaveCount(5);

    const screenshotDir = path.join(rootDir, "test-results", "ui-harness", "e2e");
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, "working-task-layout.png") });

    const firstRunning = page.locator('.working-task[data-request-id="working-e2e-1"]');
    await firstRunning.getByRole("button", { name: "Stop" }).click();
    await expect(firstRunning).toHaveClass(/status-(stopping|cancelled)/);
    await expect(firstRunning).toHaveClass(/status-cancelled/, { timeout: 5_000 });

    const betaTask = page.locator('.working-task[data-request-id="working-e2e-2"]');
    await betaTask.locator(".working-task-main").click();
    await expect.poll(() => navigationPath(page)).toContain(setup.threads[1].id);

    // The registry persists terminal activity in English whatever the UI
    // language is, and the attention amber is not part of the appearance
    // settings, so a Chinese UI on a dark surface is where both would break: a
    // finished row printing a stored English word instead of its duration, and
    // a Needs you tile keeping its near-white background under light ink.
    await page.evaluate(() => window.jasmine.updateAppSettings({ language: "zh", appearance: { surface: "#101216", ink: "#f2f4f8" } }));
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /^Working/ }).click();
    const failedRow = page.locator(".working-task.status-failed");
    await expect(failedRow).toContainText("耗时");
    await expect(failedRow).not.toContainText("Failed");
    // A run that has not reached nameable work yet reports one of the registry's
    // stock English lines, which the page has to translate rather than print.
    await expect(page.locator(".working-task.status-running").first()).toContainText("正在准备回复");
    await expect(page.locator(".working-groups")).not.toContainText("Preparing response");
    const attentionPalette = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        color: styles.getPropertyValue("--attention").trim(),
        soft: styles.getPropertyValue("--attention-soft").trim()
      };
    });
    expect(attentionPalette.color).toBe("#e9a13b");
    expect(Number.parseInt(attentionPalette.soft.slice(1, 3), 16)).toBeLessThan(80);

    await page.evaluate(async ({ threadId, projectId }) => {
      await window.jasmine.deleteThread(threadId);
      await window.jasmine.removeProject({ id: projectId });
    }, { threadId: setup.threads[3].id, projectId: setup.projects[2].id });
    await expect.poll(() => page.evaluate(async (requestId) => (await window.jasmine.getWorkingSnapshot()).items.some((item) => item.requestId === requestId), "working-e2e-4")).toBe(false);
    await expect.poll(() => page.evaluate(async (threadId) => (await window.jasmine.listThreads()).find((item) => item.id === threadId)?.projectId ?? null, setup.threads[4].id)).toBe(null);
  });

  test("notifies for the viewed chat after hiding or minimizing and restores that chat @desktop-session", async ({}, testInfo) => {
    let { page } = harness;

    await openSettings(page);
    await page.getByRole("combobox", { name: "Working task notification mode" }).selectOption("background");
    await page.getByRole("switch", { name: "Show Working task details in notifications" }).click();
    await saveSettings(page);
    await page.getByRole("button", { name: "Close settings" }).click();

    const task = await page.evaluate(async () => {
      const thread = await window.jasmine.createThread({ title: "Private notification chat" });
      return thread;
    });
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /Private notification chat/ }).click();
    await expect.poll(() => navigationPath(page)).toContain(task.id);
    await page.evaluate((threadId) => window.jasmine.updateWorkingView({ threadId }), task.id);
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
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getWorkingSnapshot()).items.find((item) => item.requestId === "working-notification-e2e")?.unread)).toBe(true);
    const notification = await harness.app.evaluate(() => (globalThis as any).__jasmineWorkingNotifications.list()[0]);
    expect(notification.body).not.toContain("Private notification chat");
    await harness.app.evaluate(() => (globalThis as any).__jasmineWorkingNotifications.click(0));
    await expect.poll(() => harness.app.evaluate(() => Boolean((globalThis as any).__jasmineTray?.isMainVisible?.()))).toBe(true);
    await expect.poll(() => navigationPath(page)).toContain(task.id);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getWorkingSnapshot()).items.find((item) => item.requestId === "working-notification-e2e")?.unread)).toBe(false);

    await harness.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("index.html"));
      (globalThis as any).__jasmineWorkingNotifications?.clear?.();
      win?.minimize();
    });
    await expect.poll(() => harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.webContents.getURL().includes("index.html") && win.isMinimized()))).toBe(true);
    await page.evaluate((threadId) => {
      void window.jasmine.sendChatMessage({
        requestId: "working-minimized-notification-e2e",
        threadId,
        content: "notification completion",
        messages: [],
        providerId: "deepseek",
        modelId: "deepseek-v4-flash"
      });
    }, task.id);
    await expect.poll(() => harness.app.evaluate(() => (globalThis as any).__jasmineWorkingNotifications?.list?.().length ?? 0)).toBe(1);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getWorkingSnapshot()).items.find((item) => item.requestId === "working-minimized-notification-e2e")?.unread)).toBe(true);
    await harness.app.evaluate(() => (globalThis as any).__jasmineWorkingNotifications.click(0));
    await expect.poll(() => harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((win) => win.webContents.getURL().includes("index.html") && !win.isMinimized()))).toBe(true);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getWorkingSnapshot()).items.find((item) => item.requestId === "working-minimized-notification-e2e")?.unread)).toBe(false);

    const userDataDir = harness.userDataDir;
    await quitElectron(harness.app);
    harness = await launchJasmine(`${testInfo.title.replace(/\W+/g, "-")}-restart`, userDataDir);
    page = harness.page;
    await openSettings(page);
    await expect(page.getByRole("combobox", { name: "Working task notification mode" })).toHaveValue("background");
    await expect(page.getByRole("switch", { name: "Show Working task details in notifications" })).not.toBeChecked();
  });

  test("recovers an unfinished request as interrupted after restart", async ({}, testInfo) => {
    let { page } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Interrupted Working chat" }));
    await page.getByRole("button", { name: /^Working/ }).click();

    // Nothing is running yet, so the page shows its empty state. Its call to
    // action has to leave the Working route: the route-sync effect skips this
    // route, so a chat started here strands the user on an unchanged screen.
    await expect(page.locator(".ui-empty-state")).toBeVisible();
    await page.getByRole("button", { name: "Start a chat" }).click();
    await expect.poll(() => navigationPath(page)).not.toContain("/working");
    await expect(page.locator(".working-page")).toHaveCount(0);
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
