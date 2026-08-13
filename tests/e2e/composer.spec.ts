import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  RED_SQUARE_BASE64,
  appendThreadPiCompaction,
  baseLaunchEnv,
  clickCenter,
  commitImeComposition,
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
  quitElectron,
  resolveElectronExecutable,
  rootDir,
  saveProvider,
  saveSettings,
  seedLargeThreadMessages,
  seedMarkdownThreadMessages,
  seedPiAgentPackageSettings,
  seedThreadPiContextUsage,
  stableChatLayoutSnapshot,
  startEmptyThread,
  startImeComposition,
  testProvider,
  type HarnessApp,
  waitForAppShellPage,
  waitForComposerSettled,
  waitForChildExit,
  waitForStableAssistant
} from "./helpers";

test.describe("Jasmine composer", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("composer grows with multiline input and Tools menu exposes always-on tools plus packages", async () => {
    const { page } = harness;
    const composer = page.locator(".rich-composer-editor");
    const initialHeight = await composer.evaluate((node) => node.getBoundingClientRect().height);

    await composer.fill("one\ntwo\nthree\nfour\nfive\nsix");
    const expandedHeight = await composer.evaluate((node) => node.getBoundingClientRect().height);

    expect(expandedHeight).toBeGreaterThan(initialHeight + 32);
    await expect(page.getByRole("button", { name: "Tools" })).toBeEnabled();
    await page.getByRole("button", { name: "Tools" }).click();
    await expect(page.locator(".tools-menu")).toBeVisible();
    await expectFloatingMenuInViewport(page, ".tools-menu", ".tools-menu-wrap .tool");
    await expect(page.locator(".tools-menu").getByRole("menuitem")).toHaveCount(2);
    await expect(page.locator(".tools-menu").getByRole("menuitemcheckbox")).toHaveCount(0);
    await expect(page.locator(".tools-menu")).toContainText("Pi tools");
    await expect(page.locator(".tools-menu")).toContainText("Packages");
    await page.locator(".tools-menu").getByRole("menuitem", { name: /Packages/ }).click();
    await expect(page.locator(".settings-panel")).toBeVisible();
    await expect(page.locator(".settings-nav button.active")).toContainText("Packages");
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator(".composer").getByRole("button", { name: "Memory" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Voice" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Preview context" })).toHaveCount(0);
  });

  test("rich composer preserves plain-text editing and IME-safe commands", async () => {
    const { page } = harness;
    await startEmptyThread(page);
    const editor = page.locator(".rich-composer-editor");

    await expect(page.locator(".composer textarea")).toHaveCount(0);
    await editor.click();
    await page.keyboard.type("one");
    await page.keyboard.down("Shift");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Shift");
    await page.keyboard.type("two");
    await expectComposerDraft(page, "one\ntwo");

    await editor.click();
    await editor.press("ControlOrMeta+A");
    await editor.evaluate((node) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "pasted plain text");
      node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
    });
    await expectComposerDraft(page, "pasted plain text");

    await editor.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await expectComposerDraft(page, "");
    await waitForComposerSettled(page);
    await page.keyboard.insertText("你说");
    await expectComposerDraft(page, "你说");
    await editor.evaluate((node) => {
      node.focus();
      const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
      if (!text) throw new Error("Composer text node is missing.");
      const range = document.createRange();
      range.setStart(text, 1);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.insertText("中");
    await expectComposerDraft(page, "你中说");

    await editor.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await expectComposerDraft(page, "");
    await waitForComposerSettled(page);
    await editor.click();
    const composition = await startImeComposition(harness.app, page, "$tech");
    await expect(page.locator(".skill-command-menu")).toHaveCount(0);
    await commitImeComposition(composition, "$tech");
    await expect(page.locator(".skill-command-menu")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("composer toolbar stays compact and shows actual context usage", async () => {
    const { page, userDataDir } = harness;
    const thread = await page.evaluate(async () => {
      const provider = (await window.jasmine.listProviders())[0];
      await window.jasmine.updateProviderModel({
        providerId: provider.id,
        modelId: provider.defaultModel,
        contextWindow: 1000
      });
      await window.jasmine.updateActivitySettings({ enabled: true, paused: true });
      return window.jasmine.createThread({ title: "Pi context usage" });
    });
    await seedThreadPiContextUsage(userDataDir, thread.id, 420);
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /Pi context usage/ }).click();

    await expect(page.locator(".thread-row.active").first()).toHaveClass(/active/);
    await expect(page.locator(".composer").getByRole("button", { name: "Tools" })).toBeEnabled();
    await expect(page.locator(".composer .run-meter")).toHaveText("42.0%/1.0k");
    await expect(page.locator(".composer .run-meter")).toHaveAttribute("title", "Pi context: 420 / 1,000 tokens");
    await expect(page.locator(".composer .activity-status-pill")).toHaveCount(0);
    await expectToolbarHasNoOverlap(page);

    await page.locator(".rich-composer-editor").fill("context ".repeat(700));
    await expect(page.locator(".composer .run-meter")).toHaveText("42.0%/1.0k");
    await expectToolbarHasNoOverlap(page);

    appendThreadPiCompaction(userDataDir, thread.id);
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /Pi context usage/ }).click();
    await expect(page.locator(".composer .run-meter")).toHaveText("?/1.0k");
  });

  test("typing a draft does not repaint loaded markdown history", async () => {
    const { page, userDataDir } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Stable typing history" }));
    // Seeded markdown keeps this focused on render isolation while message repository behavior stays in unit tests.
    seedMarkdownThreadMessages(userDataDir, thread.id, 24);
    await page.reload();
    await page.waitForSelector(".app-shell");

    await page.getByRole("button", { name: /Stable typing history/ }).click();
    await expect(page.locator(".user-bubble, .assistant-block")).toHaveCount(24);
    await expect(page.locator(".markdown-message .markdown-heading").first()).toBeVisible();
    await expect(page.locator(".shiki-loading")).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(300);

    const before = await stableChatLayoutSnapshot(page);
    await page.evaluate(() => {
      (window as Window & { __JASMINE_MESSAGE_LIST_RENDERS__?: number }).__JASMINE_MESSAGE_LIST_RENDERS__ = 0;
    });
    await page.waitForTimeout(100);
    await expect.poll(() => page.evaluate(() => (window as Window & { __JASMINE_MESSAGE_LIST_RENDERS__?: number }).__JASMINE_MESSAGE_LIST_RENDERS__ ?? 0)).toBe(0);

    await page.locator(".rich-composer-editor").fill("typing should not repaint loaded markdown history");
    await page.waitForTimeout(450);

    const renderCount = await page.evaluate(() => (window as Window & { __JASMINE_MESSAGE_LIST_RENDERS__?: number }).__JASMINE_MESSAGE_LIST_RENDERS__ ?? 0);
    const after = await stableChatLayoutSnapshot(page);
    expect(renderCount).toBe(0);
    expect(after.composerTop).toBe(before.composerTop);
    expect(after.messageScrollBottom).toBe(before.messageScrollBottom);
    expect(after.scrollTop).toBe(before.scrollTop);
  });

  test("stream ticks re-render the message list but not the sidebar or composer", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    // The long answer streams 8 chunks at 1s intervals. Measure between explicit
    // assistant-output growths so a saturated worker cannot accidentally include
    // the terminal Working/threads updates in the stream-only render window.
    const prompt = "render isolation boundary slow response slow timeline long answer";
    await page.locator(".rich-composer-editor").fill(prompt);
    await page.getByRole("button", { name: "Send" }).click();

    // Wait until the run is live and both one-off sidebar updates (the generated
    // title and Working registration) have landed before measuring stream ticks.
    // Under a saturated full-suite worker the Working event can trail the first
    // assistant chunk, so live-message visibility alone is not a sufficient
    // boundary for the zero-sidebar-render assertion below.
    await expect(page.locator(".assistant-block.live-message").last()).toBeVisible();
    await expect(page.locator(".thread-row", { hasText: "render isolation boundary" }).first()).toBeVisible();
    await expect(page.locator(".sidebar-feature-badge")).toHaveText("1");

    await page.evaluate(() => {
      const harnessWindow = window as Window & {
        __JASMINE_MESSAGE_LIST_RENDERS__?: number;
        __JASMINE_SIDEBAR_RENDERS__?: number;
        __JASMINE_COMPOSER_RENDERS__?: number;
      };
      harnessWindow.__JASMINE_MESSAGE_LIST_RENDERS__ = 0;
      harnessWindow.__JASMINE_SIDEBAR_RENDERS__ = 0;
      harnessWindow.__JASMINE_COMPOSER_RENDERS__ = 0;
    });

    const liveAssistant = page.locator(".assistant-block.live-message").last();
    const liveOutput = liveAssistant.getByLabel("Assistant output");
    for (let tick = 0; tick < 3; tick += 1) {
      const previousLength = (await liveOutput.textContent())?.length ?? 0;
      await expect.poll(async () => (await liveOutput.textContent())?.length ?? 0)
        .toBeGreaterThan(previousLength);
    }
    await expect(liveAssistant).toBeVisible();
    await expect(page.locator(".sidebar-feature-badge")).toHaveText("1");

    const counts = await page.evaluate(() => {
      const harnessWindow = window as Window & {
        __JASMINE_MESSAGE_LIST_RENDERS__?: number;
        __JASMINE_SIDEBAR_RENDERS__?: number;
        __JASMINE_COMPOSER_RENDERS__?: number;
      };
      return {
        messageList: harnessWindow.__JASMINE_MESSAGE_LIST_RENDERS__ ?? 0,
        sidebar: harnessWindow.__JASMINE_SIDEBAR_RENDERS__ ?? 0,
        composer: harnessWindow.__JASMINE_COMPOSER_RENDERS__ ?? 0
      };
    });
    expect(counts.messageList).toBeGreaterThan(0);
    expect(counts.sidebar).toBe(0);
    expect(counts.composer).toBe(0);

    await expect(page.locator(".assistant-block").last()).toContainText("Long answer paragraph 42", { timeout: 15000 });
  });

  test("Pi tools stay enabled for send, regenerate, and edit requests", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".composer").getByRole("button", { name: "Tools" }).click();
    await expect(page.locator(".tools-menu").getByRole("menuitemcheckbox")).toHaveCount(0);
    await expect(page.locator(".tools-menu")).toContainText("Pi tools");
    await page.keyboard.press("Escape");

    await page.locator(".rich-composer-editor").fill("tools state initial");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Pi tools are on.");

    await page.locator(".assistant-block").last().getByRole("button", { name: "Regenerate this response" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Pi tools are on.");
    await expect(page.locator(".assistant-block")).toHaveCount(1);

    await page.locator(".user-message-wrap").last().hover();
    await page.locator(".user-message-wrap").last().getByRole("button", { name: "Edit message" }).click();
    await page.locator(".rich-composer-editor").fill("tools state edited");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Pi tools are on.");
    await expect(page.locator(".user-bubble")).toHaveCount(1);
  });

  test("image-only attachments enable send and render as thumbnails", async () => {
    const { page } = harness;
    const imagePath = await createRedSquarePng(harness.userDataDir);
    await page.evaluate(async () => {
      const provider = (await window.jasmine.listProviders())[0];
      await window.jasmine.updateProviderModel({
        providerId: provider.id,
        modelId: provider.defaultModel,
        enabled: true,
        capabilities: { vision: true }
      });
    });
    await page.reload();

    await page.getByRole("button", { name: "Attach file" }).click();
    await expect(page.locator(".attachment-row img")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    await page.getByRole("button", { name: "Preview attachment red-square.png" }).click();
    await expect(page.locator(".image-lightbox")).toBeVisible();
    await page.getByRole("button", { name: "Close image preview" }).click();
    await expect(page.locator(".image-lightbox")).toBeHidden();
    await expect(page.locator(".attachment-row img")).toHaveCount(1);

    const attachmentRowBox = await page.locator(".attachment-row").boundingBox();
    if (!attachmentRowBox) throw new Error("Attachment row did not render.");
    await page.mouse.click(attachmentRowBox.x + attachmentRowBox.width - 2, attachmentRowBox.y + attachmentRowBox.height / 2);
    await expect(page.locator(".attachment-row img")).toHaveCount(1);

    await page.getByRole("button", { name: "Remove attachment red-square.png" }).click();
    await expect(page.locator(".attachment-row img")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.getByRole("button", { name: "Attach file" }).click();
    await expect(page.locator(".attachment-row img")).toHaveCount(1);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.locator(".message-image-grid img")).toHaveCount(1);
    // Wait for the response to settle before opening the preview: stream
    // ticks and the post-run refresh remount message rows, which detaches the
    // lightbox close button mid-click.
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply received 1 image attachment.");
    await expect(page.locator(".assistant-block.live-message")).toHaveCount(0);
    await page.getByRole("button", { name: "Preview red-square.png" }).click();
    await expect(page.locator(".image-lightbox")).toBeVisible();
    await expect(page.locator(".image-lightbox img")).toHaveCount(1);
    await page.getByRole("button", { name: "Close image preview" }).click();
    await expect(page.locator(".image-lightbox")).toBeHidden();
    await expect(page.locator(".user-bubble").last()).not.toContainText(imagePath);

    // Rebuild the row through database -> main -> preload -> renderer after a
    // real reload. The component test owns lightbox interaction, but cannot
    // prove persisted attachment JSON survives this cross-process round trip.
    const persistedThread = await page.evaluate(async () => {
      const snapshot = (window as Window & {
        __jasmineHarness?: { snapshot(): { app: { activeThreadId: string | null } } };
      }).__jasmineHarness?.snapshot();
      const thread = (await window.jasmine.listThreads()).find((item) => item.id === snapshot?.app.activeThreadId);
      if (!thread) throw new Error("Image attachment thread was not active.");
      return { id: thread.id, title: thread.title };
    });
    await page.reload();
    await page.waitForSelector(".app-shell");
    if (await page.locator(".message-image-grid img").count() === 0) {
      const threadRow = page.locator(".thread-row").filter({
        has: page.getByText(persistedThread.title, { exact: true })
      }).first();
      await threadRow.locator(".thread-item").click();
    }
    await expect.poll(() => page.evaluate(() => (
      window as Window & {
        __jasmineHarness?: { snapshot(): { app: { activeThreadId: string | null } } };
      }
    ).__jasmineHarness?.snapshot().app.activeThreadId ?? null)).toBe(persistedThread.id);
    await expect(page.locator(".message-image-grid img")).toHaveCount(1);
    await expect(page.locator(".user-bubble").last()).not.toContainText(imagePath);
  });

  test("pasting a clipboard image attaches it to the composer", async () => {
    const { app, page } = harness;
    await page.evaluate(async () => {
      const provider = (await window.jasmine.listProviders())[0];
      await window.jasmine.updateProviderModel({
        providerId: provider.id,
        modelId: provider.defaultModel,
        enabled: true,
        capabilities: { vision: true }
      });
    });
    await page.reload();
    await startEmptyThread(page);
    const clipboardState = await app.evaluate(({ clipboard, nativeImage }) => {
      const pixels = Buffer.alloc(8 * 8 * 4);
      for (let offset = 0; offset < pixels.length; offset += 4) {
        pixels[offset] = 255;
        pixels[offset + 3] = 255;
      }
      const image = nativeImage.createEmpty();
      image.addRepresentation({ scaleFactor: 1, width: 8, height: 8, buffer: pixels });
      clipboard.clear();
      clipboard.writeImage(image);
      const written = clipboard.readImage();
      return {
        sourceEmpty: image.isEmpty(),
        empty: written.isEmpty(),
        width: written.getSize().width,
        height: written.getSize().height
      };
    });
    test.skip(clipboardState.empty, "Native image clipboard is unavailable in this Windows test session.");
    expect(clipboardState).toEqual({ sourceEmpty: false, empty: false, width: 8, height: 8 });
    await page.locator(".rich-composer-editor").click();
    await page.keyboard.press("Control+V");

    await expect(page.locator(".attachment-row img")).toHaveCount(1);
    await page.locator(".attachment-chip-preview").click();
    await expect(page.locator(".image-lightbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".image-lightbox")).toBeHidden();
    await expect(page.locator(".attachment-row img")).toHaveCount(1);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".message-image-grid img")).toHaveCount(1);
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply received 1 image attachment.");

    const pastedAttachment = await page.evaluate(async () => {
      for (const thread of await window.jasmine.listThreads()) {
        const messages = await window.jasmine.listMessages({ threadId: thread.id, limit: 20 });
        const attachment = messages.flatMap((message) => message.attachments ?? []).find((item) => item.isImage && item.name.startsWith("clipboard-"));
        if (attachment) return attachment;
      }
      return null;
    });
    expect(pastedAttachment).toBeTruthy();
    expect(pastedAttachment?.path).toContain(`${path.sep}attachments${path.sep}clipboard${path.sep}`);
    await access(pastedAttachment?.path ?? "");

    await page.locator(".rich-composer-editor").fill("look at the pasted image again");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply received 1 image attachment.");
  });

  test("composer @ menu lists searchable project files", async () => {
    const { page } = harness;

    const textarea = page.locator(".rich-composer-editor");
    await textarea.fill("@");
    await expect(page.locator(".mention-menu")).toBeVisible();
    await expect(page.locator(".mention-menu")).toContainText("Files");
    await expectFloatingMenuInViewport(page, ".mention-menu", ".rich-composer-editor");
    await expect(page.locator(".mention-row", { hasText: "Open a project to search files" })).toBeDisabled();
    await expectComposerEditorText(textarea, "@");
    await textarea.fill("");
    await expect(page.locator(".mention-menu")).toBeHidden();

    const defaultProjectName = await page.evaluate(async () => {
      const projects = await window.jasmine.listProjects();
      const project = projects.find((item) => item.rootPath.replace(/\\/g, "/").endsWith("/jasmine")) ?? projects[0];
      return project?.name ?? "";
    });
    await page.locator(".project-row", { hasText: defaultProjectName }).locator(".project-item").click();
    await textarea.fill("@composerCommandItems");
    const fileRow = page.locator(".mention-row", { hasText: "composerCommandItems.ts" }).first();
    await expect(fileRow).toBeVisible();
    await fileRow.click();
    await expect(page.locator(".attachment-row")).toContainText("composerCommandItems.ts");
    await expectComposerEditorText(textarea, "");
  });
});
