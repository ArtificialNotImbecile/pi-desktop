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

test.describe("Jasmine threads and projects", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("new chat reuses a single empty draft thread @smoke", async () => {
    const { page } = harness;

    await expect(page.locator(".thread-item")).toHaveCount(1);
    await page.getByRole("button", { name: "New chat" }).first().click();
    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.locator(".thread-item")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "New chat empty" })).toHaveCount(1);
    await expect(page.locator(".empty-state")).toBeVisible();

    await page.locator(".rich-composer-editor").fill("first persisted chat");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.getByRole("button", { name: "first persisted chat 2" })).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("first persisted chat"));
      if (!thread) return null;
      const titleTrace = (await window.jasmine.listTracesForThread(thread.id)).find((run) => run.title === "Automatic title");
      return titleTrace ? {
        modelId: titleTrace.modelId,
        outputSummary: titleTrace.outputSummary,
        status: titleTrace.status
      } : null;
    })).toMatchObject({
      modelId: "deepseek-v4-flash",
      outputSummary: "first persisted chat",
      status: "success"
    });

    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.locator(".empty-state")).toBeVisible();
    await expect(page.locator(".thread-item")).toHaveCount(3);

    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.locator(".thread-item")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "New chat empty" })).toHaveCount(1);
  });

  test("local folder projects create scoped and unscoped chats, drive project runtimes, and remove safely", async ({}, testInfo) => {
    let { page } = harness;

    await expect(page.locator(".sidebar-section-heading", { hasText: "Projects" })).toBeVisible();
    await page.getByRole("button", { name: "Open Folder..." }).first().click();
    await expect(page.locator(".project-row", { hasText: "local-project" })).toBeVisible();

    const project = await page.evaluate(async () => {
      const projects = await window.jasmine.listProjects();
      const project = projects.find((item) => item.name === "local-project");
      if (!project) throw new Error("local-project was not created.");
      return project;
    });
    await expect.poll(() => navigationPath(page)).toBe(`/projects/${encodeURIComponent(project.id)}/chat/new`);
    const projectThreadCount = () => page.evaluate(async (projectId) => {
      const threads = await window.jasmine.listThreads();
      return threads.filter((item) => item.projectId === projectId).length;
    }, project.id);
    await expect.poll(projectThreadCount).toBe(0);

    const projectRow = page.locator(".project-row", { hasText: "local-project" }).first();
    await projectRow.locator(".project-item").click();
    await expect.poll(projectThreadCount).toBe(0);
    await expect(projectRow).not.toHaveClass(/active/);

    await projectRow.hover();
    await projectRow.getByRole("button", { name: "Project actions for local-project" }).click();
    await expect(page.getByRole("menuitem", { name: "Pin" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Open in Explorer" }).click();
    await expect.poll(async () => {
      try {
        return await readFile(path.join(harness.userDataDir, "explorer-open.log"), "utf8");
      } catch {
        return "";
      }
    }).toContain(project.rootPath);
    await expect.poll(projectThreadCount).toBe(0);

    await projectRow.getByRole("button", { name: "New chat in local-project" }).click();
    await expect.poll(projectThreadCount).toBe(1);
    await expect.poll(() => navigationPath(page)).toContain(`/projects/${encodeURIComponent(project.id)}/chat/`);
    await expect(projectRow).not.toHaveClass(/active/);
    await expect(page.locator(".thread-row.nested.active")).toHaveCount(1);

    await page.getByRole("button", { name: "New chat in Chats" }).click();
    await expect.poll(() => navigationPath(page)).toMatch(/^\/chats\//);
    await expect.poll(() => page.evaluate(async () => {
      const threads = await window.jasmine.listThreads();
      return threads.some((item) => item.projectId === null && item.messageCount === 0);
    })).toBe(true);

    await projectRow.locator(".project-item").click();
    await expect.poll(() => navigationPath(page)).toBe(`/projects/${encodeURIComponent(project.id)}/chat/new`);
    await expect.poll(projectThreadCount).toBe(1);
    await page.locator(".side-top").getByRole("button", { name: "New chat" }).click();
    await expect.poll(projectThreadCount).toBe(1);

    await expect(page.locator(".project-row", { hasText: "local-project" })).toBeVisible();
    await projectRow.hover();
    await projectRow.getByRole("button", { name: "New chat in local-project" }).click();
    await expect.poll(() => navigationPath(page)).toContain(`/projects/${encodeURIComponent(project.id)}/chat/`);

    const noProjectFiles = await page.evaluate(async () => window.jasmine.searchFiles({ query: "project-note", projectId: null }));
    expect(noProjectFiles).toEqual([]);
    const projectFiles = await page.evaluate(async (projectId) => window.jasmine.searchFiles({ query: "project-note", projectId, limit: 4 }), project.id);
    expect(projectFiles.map((file) => file.relativePath)).toContain("src/project-note.txt");

    await page.locator(".rich-composer-editor").fill("project cwd check");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");
    const scopedMessageState = await page.evaluate(async (projectId) => {
      const threads = await window.jasmine.listThreads();
      const thread = threads.find((item) => item.projectId === projectId && item.title.includes("project cwd check"));
      if (!thread) throw new Error("Project thread was not persisted.");
      const captures = await window.jasmine.listThreadContextTaxonomy(thread.id);
      const latest = captures.captures.at(-1);
      const taxonomy = latest ? (await window.jasmine.getContextTaxonomy(latest.id)).taxonomy : null;
      const systemPromptText = taxonomy?.items.find((item) => item.kind === "system_prompt")?.text ?? "";
      return { thread, systemPromptText };
    }, project.id);
    expect(scopedMessageState.thread.projectId).toBe(project.id);
    expect(scopedMessageState.systemPromptText).toContain(project.rootPath.replace(/\\/g, "/"));

    const scratchCwd = await page.evaluate(async () => {
      const session = await window.jasmine.startTerminal({ projectId: null, cols: 80, rows: 8 });
      await window.jasmine.stopTerminal({ sessionId: session.id });
      return session.cwd;
    });
    expect(path.normalize(scratchCwd)).toBe(path.join(harness.userDataDir, "scratch", "chats"));
    const projectCwd = await page.evaluate(async (projectId) => {
      const session = await window.jasmine.startTerminal({ projectId, cols: 80, rows: 8 });
      await window.jasmine.stopTerminal({ sessionId: session.id });
      return session.cwd;
    }, project.id);
    expect(path.normalize(projectCwd)).toBe(path.normalize(project.rootPath));

    const userDataDir = harness.userDataDir;
    await quitElectron(harness.app);
    harness = await launchJasmine(`${testInfo.title.replace(/\W+/g, "-")}-restart`, userDataDir);
    page = harness.page;
    await expect(page.locator(".project-row", { hasText: "local-project" })).toBeVisible();
    const restartedProjectRow = page.locator(".project-row", { hasText: "local-project" }).first();
    await restartedProjectRow.hover();
    await restartedProjectRow.getByRole("button", { name: "Project actions for local-project" }).click();
    await page.getByRole("menuitem", { name: "Remove project local-project" }).click();
    await expect(page.locator(".project-row", { hasText: "local-project" })).toHaveCount(0);
    const movedThread = await page.evaluate(async () => {
      const threads = await window.jasmine.listThreads();
      return threads.find((thread) => thread.title.includes("project cwd check")) ?? null;
    });
    expect(movedThread?.projectId).toBeNull();
  });

  test("thread drafts, rename, delete confirmation, and long-list paging are durable", async () => {
    const { page } = harness;

    await page.getByRole("button", { name: "New chat" }).first().click();
    await page.locator(".rich-composer-editor").fill("durable unsent draft");
    await expect.poll(() => page.evaluate(async () => {
      const draftThread = (await window.jasmine.listThreads()).find((thread) => thread.draft?.includes("durable unsent draft"));
      return draftThread?.draft ?? "";
    })).toBe("durable unsent draft");

    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.locator(".empty-state")).toBeVisible();
    await expect(page.locator(".thread-row", { hasText: "draft" })).toHaveCount(1);

    await page.reload();
    await page.locator(".thread-row", { hasText: "draft" }).getByRole("button").first().click();
    await expectComposerDraft(page, "durable unsent draft");

    await page.evaluate(async () => {
      await window.jasmine.createThread({ title: "Thread ops target" });
    });
    await page.reload();
    const targetRow = page.locator(".thread-row", { hasText: "Thread ops target" }).first();
    await targetRow.hover();
    await targetRow.getByRole("button", { name: "Rename Thread ops target" }).click();
    await page.getByRole("textbox", { name: "Thread title for Thread ops target" }).fill("Renamed ops target");
    await page.keyboard.press("Enter");
    await expect(page.locator(".thread-row", { hasText: "Renamed ops target" })).toBeVisible();

    const renamedRow = page.locator(".thread-row", { hasText: "Renamed ops target" }).first();
    await renamedRow.hover();
    await renamedRow.getByRole("button", { name: "Delete Renamed ops target" }).click();
    await expect(page.locator(".confirm-dialog")).toContainText("This cannot be undone.");
    await page.locator(".confirm-dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".thread-row", { hasText: "Renamed ops target" })).toBeVisible();

    await renamedRow.hover();
    await renamedRow.getByRole("button", { name: "Delete Renamed ops target" }).click();
    await page.locator(".confirm-dialog").getByRole("button", { name: "Delete Chat" }).click();
    await expect(page.locator(".thread-row", { hasText: "Renamed ops target" })).toHaveCount(0);

    await page.evaluate(async () => {
      for (let index = 0; index < 75; index += 1) {
        const thread = await window.jasmine.createThread({ title: `Paged thread ${index + 1}` });
        await window.jasmine.updateThreadDraft({ threadId: thread.id, content: `paged draft ${index + 1}` });
      }
    });
    await page.reload();
    await expect(page.locator(".thread-item")).toHaveCount(60);
    await page.getByRole("button", { name: "Show more chats" }).click();
    await expect.poll(() => page.locator(".thread-item").count()).toBeGreaterThan(60);
  });

  test("thread rename and delete keep the owned Pi JSONL session in sync", async () => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);
    await page.locator(".rich-composer-editor").fill("rename JSONL session");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");

    const thread = await page.evaluate(async () => (await window.jasmine.listThreads()).find((item) => item.title.includes("rename JSONL session")));
    expect(thread).toBeTruthy();
    const row = page.locator(".thread-row", { hasText: "rename JSONL session" }).first();
    await row.hover();
    await row.getByRole("button", { name: /Rename rename JSONL session/i }).click();
    await page.getByRole("textbox", { name: /Thread title for rename JSONL session/i }).fill("Renamed JSONL session");
    await page.keyboard.press("Enter");
    await expect(page.locator(".thread-row", { hasText: "Renamed JSONL session" })).toBeVisible();

    const piSession = await readThreadPiSession(userDataDir, thread!.id);
    expect(piSession.entries.some((entry) => entry.type === "session_info" && entry.name === "Renamed JSONL session")).toBe(true);
    await access(piSession.sessionFile);

    const renamedRow = page.locator(".thread-row", { hasText: "Renamed JSONL session" }).first();
    await renamedRow.hover();
    await renamedRow.getByRole("button", { name: "Delete Renamed JSONL session" }).click();
    await page.locator(".confirm-dialog").getByRole("button", { name: "Delete Chat" }).click();
    await expect(renamedRow).toHaveCount(0);
    await expect(access(piSession.sessionFile)).rejects.toThrow();
  });

  test("running responses do not force-scroll while reading loaded history", async () => {
    const { page, userDataDir } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Running history read" }));
    // Seeded data is intentional here; the user-observed behavior is scroll preservation during refresh.
    seedLargeThreadMessages(userDataDir, thread.id, 220);
    await page.reload();
    await page.waitForSelector(".app-shell");

    await page.getByRole("button", { name: /Running history read/ }).click();
    await page.locator(".load-older-messages").click();
    await expect(page.locator(".user-bubble, .assistant-block")).toHaveCount(220);
    await page.locator(".message-scroll").evaluate((node) => { node.scrollTop = 0; });
    await expect(page.locator(".message-jump-marks span")).toHaveCount(110);
    await expect.poll(async () => (await messageJumpMarkAlignment(page)).maxDelta).toBeLessThanOrEqual(4);
    expect((await messageJumpMarkAlignment(page)).monotonic).toBe(true);

    await page.locator(".rich-composer-editor").fill("slow response while reading history");
    await page.getByRole("button", { name: "Send" }).click();
    await page.waitForTimeout(120);
    const scroll = page.locator(".message-scroll");
    await scroll.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const bottomBeforeWheel = await scroll.evaluate((node) => node.scrollTop);
    const scrollBox = await scroll.boundingBox();
    expect(scrollBox).not.toBeNull();
    await page.mouse.move((scrollBox?.x ?? 0) + (scrollBox?.width ?? 0) / 2, (scrollBox?.y ?? 0) + 80);
    await page.mouse.wheel(0, -900);
    await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeLessThan(bottomBeforeWheel - 100);
    const scrollTopAfterWheel = await scroll.evaluate((node) => node.scrollTop);

    await page.waitForTimeout(450);
    const scrollTopWhileRunning = await scroll.evaluate((node) => node.scrollTop);
    expect(Math.abs(scrollTopWhileRunning - scrollTopAfterWheel)).toBeLessThanOrEqual(4);
    await expect(page.locator(".assistant-block").last()).toContainText("Slow response complete.");
    await expect(page.locator(".user-bubble, .assistant-block")).toHaveCount(222);
    const scrollTopAfterRefresh = await scroll.evaluate((node) => node.scrollTop);
    expect(Math.abs(scrollTopAfterRefresh - scrollTopAfterWheel)).toBeLessThanOrEqual(4);
  });

  test("click-only pointers keep tail follow while drag, keyboard, and scrollbar gestures pause it", async () => {
    const { page, userDataDir } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Alternate scroll intent" }));
    seedLargeThreadMessages(userDataDir, thread.id, 158);
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /Alternate scroll intent/ }).click();
    await expect(page.locator("[data-message-id]")).toHaveCount(158);

    const scroll = page.locator(".message-scroll");
    // Keep this fixture live for the whole gesture matrix. The ordinary smooth
    // stream is intentionally short and can settle before a saturated worker
    // reaches the released/cancelled pointer branches.
    await page.locator(".rich-composer-editor").fill("return long answer smooth stream scroll intent");
    await page.getByRole("button", { name: "Send" }).click();
    const live = page.locator(".assistant-block.live-message").last();
    await expect(live).toBeVisible();

    const scrollBox = await scroll.boundingBox();
    expect(scrollBox).not.toBeNull();
    const bodyX = (scrollBox?.x ?? 0) + (scrollBox?.width ?? 0) / 2;
    const bodyY = (scrollBox?.y ?? 0) + Math.min(140, (scrollBox?.height ?? 0) / 2);
    const gutterX = (scrollBox?.x ?? 0) + (scrollBox?.width ?? 0) - 2;
    const tailGap = () => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
    const visualTailOffset = () => page.locator(".assistant-block.live-message").evaluate((node) => {
      const scrollNode = document.querySelector(".message-scroll");
      if (!(scrollNode instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
      return Math.max(0, node.getBoundingClientRect().bottom - scrollNode.getBoundingClientRect().bottom);
    });
    const liveTextLength = () => live.evaluate((node) => node.textContent?.length ?? 0);
    const pointer = (type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", init: Record<string, unknown>) => (
      scroll.dispatchEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...init })
    );

    await expect.poll(visualTailOffset).toBeLessThanOrEqual(24);
    const beforeClick = await scroll.evaluate((node) => node.scrollTop);
    const beforeClickScrollHeight = await scroll.evaluate((node) => node.scrollHeight);
    const beforeClickTextLength = await liveTextLength();
    // Dispatch on the scroll surface itself. A fixed viewport coordinate can
    // land on a historical recap toggle as the live tail moves; that control is
    // intentionally a reading interaction and would correctly pause following.
    await pointer("pointerdown", { pointerId: 70, pointerType: "mouse", clientX: bodyX, clientY: bodyY, buttons: 1 });
    await pointer("pointerup", { pointerId: 70, pointerType: "mouse", clientX: bodyX, clientY: bodyY, buttons: 0 });
    await scroll.dispatchEvent("click", { bubbles: true, cancelable: true, clientX: bodyX, clientY: bodyY });
    await expect.poll(liveTextLength).toBeGreaterThan(beforeClickTextLength);
    await expect.poll(() => scroll.evaluate((node) => node.scrollHeight)).toBeGreaterThan(beforeClickScrollHeight + 20);
    await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(beforeClick + 20);
    await expect.poll(visualTailOffset).toBeLessThanOrEqual(24);

    // A scrollbar-gutter press is intent before the thumb has visibly moved. Test
    // it while the run is observably live and before any End-key recovery, so a
    // concurrent completion/anchor restore cannot masquerade as tail following.
    const beforeGutterTextLength = await liveTextLength();
    await pointer("pointerdown", { pointerId: 74, pointerType: "mouse", clientX: gutterX, clientY: bodyY, buttons: 1 });
    const gutterLockedTop = await scroll.evaluate((node) => node.scrollTop);
    await expect.poll(liveTextLength).toBeGreaterThan(beforeGutterTextLength);
    await expect.poll(tailGap).toBeGreaterThan(24);
    expect(Math.abs(await scroll.evaluate((node) => node.scrollTop) - gutterLockedTop)).toBeLessThanOrEqual(4);
    await pointer("pointerup", { pointerId: 74, pointerType: "mouse", clientX: gutterX, clientY: bodyY, buttons: 0 });

    await scroll.focus();
    await scroll.press("End");
    await expect.poll(tailGap).toBeLessThanOrEqual(24);

    // Releasing or cancelling an ordinary body press clears the candidate gesture:
    // a later move with the same pointer id must not accidentally pause following.
    const beforeReleasedMoveTextLength = await liveTextLength();
    await pointer("pointerdown", { pointerId: 71, pointerType: "touch", clientX: bodyX, clientY: bodyY, buttons: 1 });
    await pointer("pointerup", { pointerId: 71, pointerType: "touch", clientX: bodyX, clientY: bodyY, buttons: 0 });
    await pointer("pointermove", { pointerId: 71, pointerType: "touch", clientX: bodyX, clientY: bodyY - 24, buttons: 1 });
    await expect.poll(liveTextLength).toBeGreaterThan(beforeReleasedMoveTextLength);
    await expect.poll(visualTailOffset).toBeLessThanOrEqual(24);

    const beforeCancelledMoveTextLength = await liveTextLength();
    await pointer("pointerdown", { pointerId: 72, pointerType: "touch", clientX: bodyX, clientY: bodyY, buttons: 1 });
    await pointer("pointercancel", { pointerId: 72, pointerType: "touch", clientX: bodyX, clientY: bodyY, buttons: 0 });
    await pointer("pointermove", { pointerId: 72, pointerType: "touch", clientX: bodyX, clientY: bodyY - 24, buttons: 1 });
    await expect.poll(liveTextLength).toBeGreaterThan(beforeCancelledMoveTextLength);
    await expect.poll(visualTailOffset).toBeLessThanOrEqual(24);

    // Small pointer jitter remains click-like. Crossing the vertical threshold is
    // an explicit touch-reading gesture and keeps the current viewport fixed.
    const beforeJitterTextLength = await liveTextLength();
    await pointer("pointerdown", { pointerId: 73, pointerType: "touch", clientX: bodyX, clientY: bodyY, buttons: 1 });
    await pointer("pointermove", { pointerId: 73, pointerType: "touch", clientX: bodyX, clientY: bodyY - 5, buttons: 1 });
    await expect.poll(liveTextLength).toBeGreaterThan(beforeJitterTextLength);
    await expect.poll(visualTailOffset).toBeLessThanOrEqual(24);
    await pointer("pointermove", { pointerId: 73, pointerType: "touch", clientX: bodyX, clientY: bodyY - 12, buttons: 1 });
    const touchLockedTop = await scroll.evaluate((node) => node.scrollTop);
    const touchLockedTextLength = await liveTextLength();
    await expect.poll(liveTextLength).toBeGreaterThan(touchLockedTextLength);
    await expect.poll(tailGap).toBeGreaterThan(24);
    expect(Math.abs(await scroll.evaluate((node) => node.scrollTop) - touchLockedTop)).toBeLessThanOrEqual(4);
    await pointer("pointerup", { pointerId: 73, pointerType: "touch", clientX: bodyX, clientY: bodyY - 12, buttons: 0 });

    await scroll.focus();
    await scroll.press("End");
    await expect.poll(tailGap).toBeLessThanOrEqual(24);

    await scroll.focus();
    await page.keyboard.press("PageUp");
    await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeGreaterThan(100);
    // PageUp itself is a short native smooth scroll. Wait for that user-initiated
    // motion to finish, then prove a later stream tick cannot restart following.
    await expect.poll(async () => {
      const first = await scroll.evaluate((node) => node.scrollTop);
      await page.waitForTimeout(100);
      const second = await scroll.evaluate((node) => node.scrollTop);
      return Math.abs(second - first);
    }).toBeLessThanOrEqual(4);
    const pageUpLockedTop = await scroll.evaluate((node) => node.scrollTop);
    const pageUpLockedTextLength = await liveTextLength();
    await expect.poll(liveTextLength).toBeGreaterThan(pageUpLockedTextLength);
    await expect.poll(() => scroll.evaluate(
      (node, expected) => Math.abs(node.scrollTop - expected),
      pageUpLockedTop
    )).toBeLessThanOrEqual(4);

    await scroll.evaluate((node) => { node.scrollTop -= 180; });
    await page.waitForTimeout(50);
    const afterScrollbarMove = await scroll.evaluate((node) => node.scrollTop);
    const beforeScrollbarGrowth = await liveTextLength();
    await expect.poll(liveTextLength).toBeGreaterThan(beforeScrollbarGrowth);
    await expect.poll(() => scroll.evaluate((node, expected) => Math.abs(node.scrollTop - expected), afterScrollbarMove)).toBeLessThanOrEqual(4);

    await scroll.evaluate((node) => { node.scrollTop = node.scrollHeight - node.clientHeight; });
    await scroll.press("End");
    await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(24);
    await waitForStableAssistant(page, "Long answer paragraph 42", 15_000);
    await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2);
  });
});
