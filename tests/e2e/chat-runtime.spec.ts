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
  readThreadPiSession,
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

test.describe("Jasmine chat runtime", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("running live messages stream thinking, show tool starts, and finish tool summaries", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("slow response slow timeline write live render");
    await page.getByRole("button", { name: "Send" }).click();

    const liveAssistant = page.locator(".assistant-block.live-message").last();
    await expect(liveAssistant).toBeVisible();
    await expect(liveAssistant.locator(".thinking-markdown")).toContainText("Need to inspect");
    const writeTool = liveAssistant.locator(".tool-run-item", { hasText: "src/example.ts" });
    await expect(writeTool).toContainText("writing");
    await expect(writeTool).not.toContainText("wrote -");
    await expect(liveAssistant.locator(".timeline-output")).toContainText("Slow", { timeout: 2000 });
    await expect(page.locator(".message-actions")).toHaveCount(0);

    const settledAssistant = await waitForStableAssistant(page, "Slow response complete.");
    await expect(settledAssistant.getByLabel("Assistant output")).toContainText("Slow response complete.");
    await expect(settledAssistant.getByRole("button", { name: "Show work details" })).toHaveAttribute("aria-expanded", "false");
    await expect(settledAssistant.locator(".run-recap-details")).toBeHidden();
    await settledAssistant.getByRole("button", { name: "Show work details" }).click();
    await expect(settledAssistant).toContainText("wrote - 4 lines, 44 bytes");
  });

  test("window destroyed mid-stream does not crash the main process", async () => {
    // Own instance with a wide stream throttle so a chunk reliably lands on the
    // trailing setTimeout path instead of the (promise-handled) direct flush.
    const crash = await launchJasmine("destroyed-mid-stream", undefined, {
      JASMINE_E2E_STREAM_THROTTLE_MS: "1500"
    });
    try {
      const { app, page } = crash;
      await startEmptyThread(page);

      // Capture main-process uncaught exceptions directly. This also replaces
      // Electron's default handler, which would otherwise block the process
      // behind a modal "A JavaScript error occurred in the main process" box.
      await app.evaluate(() => {
        const globals = globalThis as { __mainCrashes?: string[] };
        globals.__mainCrashes = [];
        process.on("uncaughtException", (error) => {
          globals.__mainCrashes?.push(String(error));
        });
      });

      // "slow timeline" streams chunks at a 1s cadence: chunk 1 flushes
      // immediately, chunk 2 (t=2s) lands inside the 1.5s throttle window and
      // schedules a trailing timer for t=2.5s.
      await page.locator(".rich-composer-editor").fill("slow timeline stream then quit");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".assistant-block.live-message").last()).toBeVisible();

      // Destroy the renderer before that timer fires. Without the
      // destroyed-WebContents guard the timer callback throws an uncaught
      // "Object has been destroyed" TypeError in the main process.
      await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
      });
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const crashes = await app.evaluate(() => (globalThis as { __mainCrashes?: string[] }).__mainCrashes ?? []);
      expect(crashes).toEqual([]);

      const closed = app.waitForEvent("close");
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
      await closed;
    } finally {
      await quitElectron(crash.app);
      await rm(crash.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("message jump rail stays out of queued message controls while a response is running", async () => {
    const { page, userDataDir } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Queue rail overlap" }));
    seedLargeThreadMessages(userDataDir, thread.id, 60);
    await page.reload();
    await page.waitForSelector(".app-shell");

    await page.getByRole("button", { name: /Queue rail overlap/ }).click();
    await expect(page.locator(".message-jump-rail")).toBeVisible();
    await page.locator(".rich-composer-editor").fill("slow response slow timeline queue rail base");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();

    await page.locator(".rich-composer-editor").fill("queued rail boundary request");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect(page.locator(".queue-item")).toHaveCount(1);
    await page.getByRole("button", { name: "Open user message navigation" }).click();
    await expect(page.locator(".message-jump-menu")).toHaveCSS("opacity", "1");

    const geometry = await page.evaluate(() => {
      const rail = document.querySelector(".message-jump-rail")?.getBoundingClientRect();
      const composer = document.querySelector(".composer")?.getBoundingClientRect();
      const deleteButton = document.querySelector("[aria-label='Delete queued message 1']")?.getBoundingClientRect();
      if (!rail || !composer || !deleteButton) throw new Error("Queue rail geometry missing.");
      const overlapsDelete = !(rail.right < deleteButton.left || rail.left > deleteButton.right || rail.bottom < deleteButton.top || rail.top > deleteButton.bottom);
      return {
        railBottom: rail.bottom,
        composerTop: composer.top,
        overlapsDelete
      };
    });
    expect(geometry.railBottom).toBeLessThanOrEqual(geometry.composerTop - 4);
    expect(geometry.overlapsDelete).toBe(false);
  });

  test("running composer queues editable follow-ups, deletes pending rows, steers after queueing, and ignores nearby non-control clicks", async () => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("slow response slow timeline queue base");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();

    await page.locator(".rich-composer-editor").fill("queued follow up request");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect(page.locator(".queue-item")).toHaveCount(1);
    await expect(page.locator(".queue-item").first()).toContainText("queued follow up request");
    await expectComposerEditorText(page.locator(".rich-composer-editor"), "");

    await page.getByRole("button", { name: "Edit queued message 1" }).click();
    await page.getByRole("textbox", { name: "Edit queued message 1" }).fill("edited queued follow up request");
    await page.locator(".queue-item").first().getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".queue-item").first()).toContainText("edited queued follow up request");

    await page.locator(".rich-composer-editor").fill("queued delete request");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect(page.locator(".queue-item")).toHaveCount(2);
    await page.getByRole("button", { name: "Delete queued message 2" }).click();
    await expect(page.locator(".queue-item")).toHaveCount(1);
    await expect(page.locator(".queue-row")).not.toContainText("queued delete request");

    const spacerBox = await page.locator(".composer-spacer").boundingBox();
    expect(spacerBox).not.toBeNull();
    await page.mouse.click((spacerBox?.x ?? 0) + Math.min(6, (spacerBox?.width ?? 12) / 2), (spacerBox?.y ?? 0) + (spacerBox?.height ?? 24) / 2);
    await expect(page.locator(".queue-mode-menu")).toHaveCount(0);
    await expect(page.locator(".queue-item")).toHaveCount(1);

    await page.locator(".rich-composer-editor").fill("steer correction request slow timeline");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect(page.locator(".queue-item")).toHaveCount(2);
    await page.locator(".queue-item").nth(1).getByRole("button", { name: "Steer", exact: true }).click();
    await expect(page.locator(".queue-item").nth(1)).toContainText("Steer");
    const e2eArtifactDir = path.join(rootDir, "test-results", "ui-harness", "e2e");
    await mkdir(e2eArtifactDir, { recursive: true });
    await page.screenshot({ path: path.join(e2eArtifactDir, "queue-message-row.png") });

    await expect(page.locator(".user-bubble", { hasText: "steer correction request slow timeline" })).toBeVisible({ timeout: 20000 });
    // Zero-latency steer: the steered user turn renders at the delivery instant in a live
    // streaming state, before the steered reply emits any token (not after the run finishes).
    await expect(page.locator(".assistant-block.live-message").last()).toBeVisible();
    await expect(page.locator(".message-stack")).not.toContainText("Steered response complete: steer correction request slow timeline");
    await expect(page.locator(".assistant-block.live-message", { hasText: "Steered response" }).last()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".queue-item")).toHaveCount(1);
    await expect(page.locator(".assistant-block").last()).toContainText("Queued follow-up complete: edited queued follow up request", { timeout: 30000 });
    await expect(page.locator(".queue-item")).toHaveCount(0);
    await expect(page.locator(".assistant-block.live-message")).toHaveCount(0, { timeout: 30000 });

    await expect.poll(async () => page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("slow response slow timeline queue base"));
      return thread ? (await window.jasmine.listMessages(thread.id)).length : 0;
    }), { timeout: 10000 }).toBe(6);

    const persisted = await page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("slow response slow timeline queue base"));
      if (!thread) throw new Error("Queued thread missing.");
      return {
        threadId: thread.id,
        messages: (await window.jasmine.listMessages(thread.id)).map((message) => ({
          role: message.role,
          content: message.content
        })),
        assistantRuns: (await window.jasmine.listMessages(thread.id))
          .filter((message) => message.role === "assistant")
          .map((message) => ({ runId: message.runId ?? null, elapsedMs: message.elapsedMs ?? null }))
      };
    });
    expect(persisted.messages).toEqual([
      { role: "user", content: "slow response slow timeline queue base" },
      { role: "assistant", content: "Slow response complete." },
      { role: "user", content: "steer correction request slow timeline" },
      { role: "assistant", content: "Steered response complete: steer correction request slow timeline" },
      { role: "user", content: "edited queued follow up request" },
      { role: "assistant", content: "Queued follow-up complete: edited queued follow up request" }
    ]);
    expect(new Set(persisted.assistantRuns.map((message) => message.runId)).size).toBe(1);
    expect(persisted.assistantRuns.every((message) => Boolean(message.runId))).toBe(true);
    expect(persisted.assistantRuns.slice(0, -1).every((message) => message.elapsedMs === null)).toBe(true);
    expect(Number(persisted.assistantRuns.at(-1)?.elapsedMs)).toBeGreaterThan(0);
    const piSession = await readThreadPiSession(userDataDir, persisted.threadId);
    expect(piSession.sessionId).toBe(persisted.threadId);
    expect(piSession.formatVersion).toBeGreaterThan(0);
    expect(piSession.messageEntryIds).toHaveLength(6);
    expect(piSession.messageEntryIds.every(Boolean)).toBe(true);
    const piSessionText = JSON.stringify(piSession.entries);
    expect(piSessionText).toContain("steer correction request slow timeline");
    expect(piSessionText).toContain("edited queued follow up request");
    expect(piSessionText).not.toContain("queued delete request");
  });

  test("running response completion does not overwrite another active thread", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("slow response first thread slow timeline");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block.live-message")).toBeVisible();

    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.locator(".empty-state")).toBeVisible();
    await page.locator(".rich-composer-editor").fill("fast second thread");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".message-stack")).toContainText("fast second thread");
    await expect(page.locator(".message-stack")).not.toContainText("slow response first thread");

    await expect(page.getByRole("button", { name: /slow response first thread/i })).toBeVisible();
    await page.getByRole("button", { name: /slow response first thread/i }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Slow response complete.");
  });

  test("running response can be stopped without canceling background thread work", async () => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("slow timeline stoppable tool stop regression");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
    const activeAssistant = page.locator(".assistant-block").last();
    // Stop only after the first stream chunk visibly rendered thinking + tool
    // work; a fixed sleep raced the first paint and could stop an empty run.
    await expect(activeAssistant.locator(".message-timeline")).toContainText("Thinking");
    await expect(activeAssistant.locator(".tool-run-item")).toContainText("find / -name node");
    await page.getByRole("button", { name: "Stop response" }).click();
    await expect(activeAssistant.getByRole("button", { name: "Hide work details" })).toHaveAttribute("aria-expanded", "true");
    await expect(activeAssistant.locator(".run-recap-label")).toContainText("Stopped after");
    await expect(activeAssistant.locator(".message-timeline")).toContainText("Stopped");
    await expect(activeAssistant.locator(".message-timeline")).toContainText("The response was stopped by the user.");
    await expect(activeAssistant.locator(".message-timeline")).toContainText("Thinking");
    await expect(activeAssistant.locator(".tool-run-item")).toContainText("find / -name node");
    await expect(activeAssistant.locator(".tool-run-status")).toContainText("stopped");
    await expect(activeAssistant.locator(".tool-run-status")).not.toContainText("running");
    await expect(page.locator(".error-strip")).toBeHidden();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

    await quitElectron(harness.app);
    harness = await launchJasmine("stopped-timeline-reopen", userDataDir);
    const reopenedPage = harness.page;
    const stoppedThreadRow = reopenedPage.locator(".thread-row", { hasText: "slow timeline stoppable" }).first();
    await expect(stoppedThreadRow).toBeVisible();
    await stoppedThreadRow.click();
    const reopenedAssistant = reopenedPage.locator(".assistant-block").last();
    await expect(reopenedAssistant.getByRole("button", { name: "Hide work details" })).toHaveAttribute("aria-expanded", "true");
    await expect(reopenedAssistant.locator(".message-timeline")).toContainText("Thinking");
    await expect(reopenedAssistant.locator(".tool-run-item")).toContainText("find / -name node");
    await expect(reopenedAssistant.locator(".message-timeline")).toContainText("Stopped");
    await expect(reopenedAssistant.locator(".tool-run-status")).toContainText("stopped");
    await expect(reopenedAssistant.locator(".tool-run-status")).not.toContainText("running");

    await reopenedPage.locator(".rich-composer-editor").fill("continue after stopped tool run");
    await reopenedPage.getByRole("button", { name: "Send" }).click();
    await expect(reopenedPage.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(reopenedPage.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(reopenedPage.locator(".error-strip")).toBeHidden();
    const stoppedThreadId = await reopenedPage.evaluate(async () => (await window.jasmine.listThreads()).find((thread) => thread.title.includes("slow timeline stoppable"))?.id);
    expect(stoppedThreadId).toBeTruthy();
    const stoppedPiSession = await readThreadPiSession(userDataDir, stoppedThreadId!);
    expect(stoppedPiSession.messageEntryIds).toHaveLength(4);
    expect(stoppedPiSession.messageEntryIds.every(Boolean)).toBe(true);
    expect(JSON.stringify(stoppedPiSession.entries)).toContain('"stopReason":"aborted"');

    const pageAfterReopen = harness.page;
    await pageAfterReopen.getByRole("button", { name: "New chat" }).first().click();
    await expect(pageAfterReopen.locator(".empty-state")).toBeVisible();
    await pageAfterReopen.locator(".rich-composer-editor").fill("slow response background keepalive");
    await pageAfterReopen.getByRole("button", { name: "Send" }).click();
    await expect(pageAfterReopen.getByRole("button", { name: "Stop response" })).toBeVisible();
    await pageAfterReopen.getByRole("button", { name: "New chat" }).first().click();
    await expect(pageAfterReopen.locator(".empty-state")).toBeVisible();
    const backgroundRow = pageAfterReopen.locator(".thread-row", { hasText: "slow response background keepali" }).first();
    await expect(backgroundRow).toBeVisible();
    await backgroundRow.click();
    await expect(pageAfterReopen.locator(".assistant-block").last()).toContainText("Slow response complete.");
  });

  test("provider calls stay auditable through IPC while trace chrome is absent from chat", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("traceable provider call");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");

    const traceMeta = await page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("traceable provider call"));
      if (!thread) throw new Error("Trace test thread missing.");
      const assistant = (await window.jasmine.listMessages(thread.id)).find((message) => message.role === "assistant");
      if (!assistant) throw new Error("Trace test assistant message missing.");
      const runs = await window.jasmine.listTracesForMessage(assistant.id);
      const detail = await window.jasmine.getTrace(runs[0].id);
      return {
        assistantId: assistant.id,
        runCount: runs.length,
        detailMessageId: detail.messageId,
        detailModelId: detail.modelId
      };
    });
    expect(traceMeta.runCount).toBe(1);
    expect(traceMeta.detailMessageId).toBe(traceMeta.assistantId);
    expect(traceMeta.detailModelId).toBe("deepseek-v4-flash");

    await expect(page.getByRole("button", { name: "Open trace" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Trace panel" })).toHaveCount(0);
    await expect(page.locator(".trace-panel")).toBeHidden();
  });

  test("web search can be configured, used in chat, and audited in traces", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await enableWebSearchFallback(page);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getWebSearchSettings()).enabled)).toBe(true);

    await page.locator(".rich-composer-editor").fill("current jasmine web search check");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Web search used: Jasmine search result");
    await expect(page.locator(".assistant-block").last().locator(".web-search-used-line")).toContainText("https://example.com/jasmine-search");

    const traceMeta = await page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("current jasmine web search"));
      if (!thread) throw new Error("Web search thread missing.");
      const messages = await window.jasmine.listMessages(thread.id);
      const assistant = messages.find((message) => message.role === "assistant");
      const runs = await window.jasmine.listTracesForThread(thread.id);
      const relevantRuns = runs.filter((run) => run.title === "Web search" || run.title.includes("chat completion"));
      return {
        messageSearchCount: assistant?.webSearchUsed?.length ?? 0,
        searchTrace: runs.find((run) => run.title === "Web search")?.outputSummary ?? "",
        runCount: relevantRuns.length
      };
    });
    expect(traceMeta.messageSearchCount).toBeGreaterThan(0);
    expect(traceMeta.searchTrace).toContain("https://example.com/jasmine-search");
    expect(traceMeta.runCount).toBe(2);

    await openSettings(page, "Web Search");
    await expect(page.getByRole("switch", { name: "Use web search" }).locator(".ui-switch-label")).toHaveCount(0);
    await expect(page.getByRole("spinbutton", { name: "Web search result limit" })).toBeEnabled();
    await page.getByRole("spinbutton", { name: "Web search result limit" }).fill("3");
    await page.locator(".settings-actions").getByRole("button", { name: "Save" }).click();
    await expect.poll(() => page.evaluate(async () => {
      const settings = await window.jasmine.getWebSearchSettings();
      return `${settings.provider}:${settings.maxResults}`;
    })).toBe("duckduckgo:3");
  });

  test("web search aborts are traced without failing the base chat", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await enableWebSearchFallback(page);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getWebSearchSettings()).enabled)).toBe(true);

    await page.locator(".rich-composer-editor").fill("abort web search regression");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await expect(page.locator(".error-strip")).toBeHidden();

    const traceMeta = await page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("abort web search"));
      if (!thread) throw new Error("Abort regression thread missing.");
      const messages = await window.jasmine.listMessages(thread.id);
      const runs = await window.jasmine.listTracesForThread(thread.id);
      const searchTrace = runs.find((run) => run.title === "Web search");
      const providerTrace = runs.find((run) => run.title.includes("chat completion"));
      const relevantRuns = runs.filter((run) => run.title === "Web search" || run.title.includes("chat completion"));
      const settings = await window.jasmine.getWebSearchSettings();
      return {
        assistantCount: messages.filter((message) => message.role === "assistant").length,
        searchStatus: searchTrace?.status,
        searchError: searchTrace?.error ?? "",
        providerStatus: providerTrace?.status,
        settingsError: settings.lastError ?? "",
        runCount: relevantRuns.length
      };
    });
    expect(traceMeta.assistantCount).toBe(1);
    expect(traceMeta.searchStatus).toBe("error");
    expect(traceMeta.searchError).toContain("Web search timed out");
    expect(traceMeta.providerStatus).toBe("success");
    expect(traceMeta.settingsError).toContain("Web search timed out");
    expect(traceMeta.runCount).toBe(2);

    await expect(page.getByRole("button", { name: "Trace panel" })).toHaveCount(0);
  });

  test("regenerate replaces the selected assistant turn and truncates later messages", async () => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("first branch");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "First branch reply.");

    await page.locator(".rich-composer-editor").fill("second branch slow timeline");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".message-actions")).toHaveCount(0);
    await waitForStableAssistant(page, "Second branch reply.");
    await expect(page.locator(".user-bubble")).toHaveCount(2);
    await expect(page.locator(".assistant-block")).toHaveCount(2);

    await page.locator(".assistant-block").first().getByRole("button", { name: "Regenerate this response" }).click();

    await expect(page.locator(".user-bubble")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".assistant-block:not(.live-message)")).toHaveCount(1, { timeout: 10_000 });
    await waitForStableAssistant(page, "First branch reply.");
    await expect(page.locator(".message-stack")).not.toContainText("second branch");
    await expect(page.locator(".message-stack")).not.toContainText("Second branch reply.");
    const threadId = await page.evaluate(async () => (await window.jasmine.listThreads()).find((thread) => thread.title.includes("first branch"))?.id);
    expect(threadId).toBeTruthy();
    const piSession = await readThreadPiSession(userDataDir, threadId!);
    expect(piSession.messageEntryIds).toHaveLength(2);
    expect(piSession.messageEntryIds.every(Boolean)).toBe(true);
    expect(JSON.stringify(piSession.entries)).toContain("second branch slow timeline");
  });

  test("editing a user message resends that branch and clears later turns", async () => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("first branch");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "First branch reply.");

    await page.locator(".rich-composer-editor").fill("second branch");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Second branch reply.");

    await page.locator(".user-message-wrap").first().hover();
    await page.locator(".user-message-wrap").first().getByRole("button", { name: "Edit message" }).click();
    await expect(page.locator(".edit-banner")).toContainText("Editing message");
    await expectComposerDraft(page, "first branch");

    await page.locator(".rich-composer-editor").fill("first branch edited");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.locator(".user-bubble")).toHaveCount(1);
    await expect(page.locator(".assistant-block")).toHaveCount(1);
    await expect(page.locator(".user-bubble").first()).toContainText("first branch edited");
    await waitForStableAssistant(page, "First branch reply.");
    await expect(page.locator(".message-stack")).not.toContainText("second branch");
    await expect(page.locator(".message-stack")).not.toContainText("Second branch reply.");
    const threadId = await page.evaluate(async () => (await window.jasmine.listThreads()).find((thread) => thread.title.includes("first branch"))?.id);
    expect(threadId).toBeTruthy();
    const piSession = await readThreadPiSession(userDataDir, threadId!);
    expect(piSession.messageEntryIds).toHaveLength(2);
    expect(piSession.messageEntryIds.every(Boolean)).toBe(true);
    const piSessionText = JSON.stringify(piSession.entries);
    expect(piSessionText).toContain("first branch edited");
    expect(piSessionText).toContain("second branch");
  });

  test("missing provider key offers settings recovery and retry avoids duplicate user turns", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.evaluate(async () => {
      const provider = (await window.jasmine.listProviders())[0];
      await window.jasmine.updateProvider({
        id: provider.id,
        apiKeyRef: "env:JASMINE_E2E_MISSING_KEY"
      });
    });
    await page.reload();

    await page.locator(".rich-composer-editor").fill("Trigger missing provider");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".error-strip")).toContainText("not set");
    await page.getByRole("button", { name: "Configure provider" }).click();
    await expect(page.locator(".settings-panel")).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();

    const userCountBeforeRetry = await page.locator(".user-bubble").count();
    await page.evaluate(async () => {
      const provider = (await window.jasmine.listProviders())[0];
      await window.jasmine.updateProvider({
        id: provider.id,
        apiKeyRef: "env:DEEPSEEK_API_KEY"
      });
    });
    await page.getByRole("button", { name: "Regenerate this response" }).last().click();

    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect.poll(() => page.locator(".user-bubble").count()).toBe(userCountBeforeRetry);
  });
});
