import { expect, test, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  RED_SQUARE_BASE64,
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
  seedLegacyDeepSeekContentProjection,
  seedPiAgentPackageSettings,
  stableChatLayoutSnapshot,
  startEmptyThread,
  testProvider,
  type HarnessApp,
  waitForAppShellPage,
  waitForChildExit,
  waitForStableAssistant
} from "./helpers";

test.describe("Jasmine message rendering", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("assistant message icon actions have accessible names", async () => {
    const { page } = harness;

    await page.locator(".rich-composer-editor").fill("hello accessibility");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");

    await expect(page.getByRole("button", { name: "Copy message" }).last()).toBeVisible();
    await expect(page.getByRole("button", { name: "Regenerate this response" }).last()).toBeVisible();

    const latestAssistant = page.locator(".assistant-block").last();
    await latestAssistant.getByRole("button", { name: "Message actions" }).click();
    await expect(page.locator(".message-menu")).toBeVisible();
    await expect(page.locator(".message-menu .ui-menu-item")).toHaveCount(3);
    await expect(page.locator(".message-menu .ui-menu-item").first()).toHaveCSS("border-style", "none");
    await page.keyboard.press("Escape");
    await expect(page.locator(".message-menu")).toBeHidden();

    await latestAssistant.getByRole("button", { name: "Message actions" }).click();
    await page.locator(".message-menu").getByRole("button", { name: "Copy message" }).click();
    await expect(page.locator(".toast")).toHaveText("Copied");

    await page.locator(".assistant-block").last().getByRole("button", { name: "Message actions" }).click();
    await page.locator(".message-menu").getByRole("button", { name: "Remember this" }).click();
    await expect(page.locator(".memory-dialog")).toBeVisible();
    await page.locator(".memory-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".memory-dialog")).toBeHidden();

    await page.locator(".assistant-block").last().getByRole("button", { name: "Message actions" }).click();
    await page.locator(".message-menu").getByRole("button", { name: "Retry from here" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");

    await expect(latestAssistant.getByRole("button", { name: "Show work details" })).toBeVisible();
    await expect(latestAssistant.locator(".run-recap-details")).toBeHidden();
    await expect(latestAssistant.getByRole("button", { name: "Open trace" })).toHaveCount(0);
  });

  test("assistant timeline renders chronological thinking, tool calls, results, and output", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("show timeline tool call");
    await page.getByRole("button", { name: "Send" }).click();

    const latestAssistant = await waitForStableAssistant(page, "Mock reply from Jasmine.");
    const recapToggle = latestAssistant.getByRole("button", { name: "Show work details" });
    await expect(recapToggle).toHaveAttribute("aria-expanded", "false");
    await expect(latestAssistant.locator(".run-recap-details")).toBeHidden();
    await expect(latestAssistant.getByLabel("Assistant output")).toContainText("Mock reply from Jasmine.");
    await recapToggle.click();
    await expect(latestAssistant.locator(".run-recap-details")).toBeVisible();
    await expect(latestAssistant.locator(".message-run-line")).toContainText("deepseek-v4-flash");
    await expect(latestAssistant.locator(".message-timeline")).not.toContainText("Thinking level");
    await expect(latestAssistant.locator(".thinking-item")).not.toContainText("Need to inspect");
    const readTool = latestAssistant.locator(".tool-run-item", { hasText: "AGENTS.md" });
    await expect(readTool).toContainText("read");
    await expect(readTool).toContainText("read - 1 line");
    await expect(readTool).not.toContainText("Project instructions loaded.");

    const thinkingToggle = latestAssistant.getByRole("button", { name: "Thinking", exact: true });
    await expect(thinkingToggle).toHaveAttribute("aria-expanded", "false");
    await thinkingToggle.click();
    await expect(thinkingToggle).toHaveAttribute("aria-expanded", "true");
    await expect(latestAssistant.locator(".thinking-item")).toContainText("Need to inspect");
    await expect(latestAssistant.locator(".thinking-markdown .markdown-message")).toContainText("Need to inspect");

    const toolToggle = readTool.getByRole("button");
    await expect(toolToggle).toHaveAttribute("aria-expanded", "false");
    await toolToggle.click();
    await expect(toolToggle).toHaveAttribute("aria-expanded", "true");
    await expect(readTool).toContainText("INPUT");
    await expect(readTool).toContainText("OUTPUT");
    await expect(readTool).toContainText("Project instructions loaded.");

    const timeline = await page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("show timeline tool call"));
      if (!thread) throw new Error("Timeline thread missing.");
      const assistant = (await window.jasmine.listMessages(thread.id)).find((message) => message.role === "assistant");
      return assistant?.timeline?.map((item) => ({ kind: item.kind, title: item.kind === "system" ? item.title : "" })) ?? [];
    });
    expect(timeline.map((item) => item.kind).slice(-4)).toEqual(["thinking", "tool_call", "tool_result", "assistant_text"]);
    expect(timeline.some((item) => item.kind === "system" && item.title === "Model")).toBe(true);
  });

  test("continued imported DeepSeek content-only tool turns stay collapsible without becoming Thinking after restart", async ({}, testInfo) => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);
    await page.locator(".rich-composer-editor").fill("seed imported deepseek continuation");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");

    await quitElectron(harness.app);
    const threadId = seedLegacyDeepSeekContentProjection(userDataDir);
    harness = await launchJasmine(`${testInfo.title}-restart`, userDataDir);

    const repairedAssistant = harness.page.locator(".assistant-block").last();
    await expect(repairedAssistant.getByLabel("Assistant output")).toContainText("Visible final answer.");
    await expect(repairedAssistant.getByLabel("Assistant output")).not.toContainText("Mock reply from Jasmine.");
    await expect(repairedAssistant.locator(".run-recap-label")).toHaveText("Worked for 3m 49s");
    await expect(repairedAssistant.getByRole("button", { name: "Show work details" })).toHaveAttribute("aria-expanded", "false");
    await repairedAssistant.getByRole("button", { name: "Show work details" }).click();
    await expect(repairedAssistant.locator(".message-run-line")).toContainText("deepseek-v4-flash");
    await expect(repairedAssistant.locator(".message-run-line")).toContainText("high");
    const preambleToggle = repairedAssistant.getByRole("button", { name: "Tool preamble", exact: true });
    await expect(preambleToggle).toHaveAttribute("aria-expanded", "false");
    await expect(repairedAssistant.getByRole("button", { name: "Thinking", exact: true })).toHaveCount(0);
    await preambleToggle.click();
    await expect(preambleToggle).toHaveAttribute("aria-expanded", "true");
    await expect(repairedAssistant.locator(".tool-preamble-item")).toContainText("Mock reply from Jasmine.");

    await repairedAssistant.getByRole("button", { name: "Copy message" }).click();
    await expect.poll(() => harness.page.evaluate(() => window.jasmine.readClipboardText()))
      .toBe("Visible final answer.");
    await repairedAssistant.getByRole("button", { name: "Message actions" }).click();
    await harness.page.locator(".message-menu").getByRole("button", { name: "Remember this" }).click();
    await expect(harness.page.getByRole("textbox", { name: "Memory content" })).toHaveValue("Visible final answer.");
    await harness.page.locator(".memory-dialog").getByRole("button", { name: "Cancel", exact: true }).click();

    const stored = await harness.page.evaluate(async (id) => {
      const assistant = (await window.jasmine.listMessages(id)).find((message) => message.role === "assistant");
      return {
        content: assistant?.content,
        kinds: assistant?.timeline?.filter((item) => item.kind !== "system").map((item) => item.kind),
        effort: assistant?.timeline?.find((item) => item.kind === "system" && item.title === "Thinking level")?.text
      };
    }, threadId);
    expect(stored).toEqual({
      content: "Mock reply from Jasmine.\nVisible final answer.",
      kinds: ["assistant_text", "tool_call", "tool_result", "assistant_text"],
      effort: "high"
    });
  });

  test("assistant timeline pairs tool results across interleaved thinking", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("show timeline interleaved tools");
    await page.getByRole("button", { name: "Send" }).click();

    const latestAssistant = page.locator(".assistant-block").last();
    const readTool = latestAssistant.locator(".tool-run-item", { hasText: "document-analysis" }).first();
    const bashTool = latestAssistant.locator(".tool-run-item", { hasText: "ls -R" }).first();
    await expect(readTool).toContainText("read - 202 lines");
    await expect(bashTool).toContainText("done - 15 lines");
    await expect(readTool.locator(".tool-run-status")).not.toContainText("reading");
    await expect(bashTool.locator(".tool-run-status")).not.toContainText("running");
    await expect(latestAssistant.locator(".tool-run-status.running")).toHaveCount(0);
  });

  test("expanded thinking markdown stays in one left-aligned column", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("show rich thinking timeline");
    await page.getByRole("button", { name: "Send" }).click();

    const latestAssistant = await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await expandWorkDetails(latestAssistant);
    await latestAssistant.getByRole("button", { name: "Thinking", exact: true }).click();
    const thinkingMarkdown = latestAssistant.locator(".thinking-markdown .markdown-message");
    await expect(thinkingMarkdown).toContainText("fenced yaml blocks");
    await expect(thinkingMarkdown.locator("code", { hasText: "yaml" })).toBeVisible();
    const layout = await thinkingMarkdown.evaluate((element) => {
      const blocks = Array.from(element.querySelectorAll(":scope > p, :scope > ul, :scope > ol"));
      return {
        display: getComputedStyle(element).display,
        alignments: blocks.map((block) => {
          const rect = block.getBoundingClientRect();
          return {
            tag: block.tagName.toLowerCase(),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            textAlign: getComputedStyle(block).textAlign
          };
        })
      };
    });
    expect(layout.display).toBe("block");
    expect(layout.alignments.length).toBeGreaterThanOrEqual(3);
    const firstLeft = layout.alignments[0].left;
    for (const item of layout.alignments) {
      expect(Math.abs(item.left - firstLeft)).toBeLessThanOrEqual(2);
      expect(item.width).toBeGreaterThan(300);
      expect(item.textAlign).toBe("left");
    }
  });

  test("assistant tool timeline summarizes write details without dumping content", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("show write timeline");
    await page.getByRole("button", { name: "Send" }).click();
    const writeMessage = page.locator(".assistant-block").last();
    const writeTool = writeMessage.locator(".tool-run-item", { hasText: "src/example.ts" });
    await expect(writeTool).toContainText("write");
    await expect(writeTool).toContainText("wrote - 4 lines, 44 bytes");
    await expect(writeTool).not.toContainText("Successfully wrote");
    await expect(writeTool).not.toContainText("export function hello");
    await expect(writeTool.locator(".tool-run-main code")).toHaveCount(0);
    // Wait for streaming to finish before reading computed styles: the live
    // message re-renders on stream completion and can detach the measured row,
    // which makes getComputedStyle return empty values.
    await expect(page.locator(".assistant-block.live-message")).toHaveCount(0, { timeout: 10_000 });
    await expandWorkDetails(writeMessage);
    const compactTypography = await writeTool.locator(".tool-run-toggle").evaluate((row) => {
      const target = row.querySelector(".tool-run-target");
      const label = row.querySelector(".tool-run-main b");
      const status = row.querySelector(".tool-run-status");
      if (!(target instanceof HTMLElement) || !(label instanceof HTMLElement) || !(status instanceof HTMLElement)) throw new Error("Tool compact typography nodes missing.");
      return {
        rowFont: getComputedStyle(row).fontFamily,
        targetFont: getComputedStyle(target).fontFamily,
        targetBackground: getComputedStyle(target).backgroundColor,
        targetHeight: target.getBoundingClientRect().height,
        labelWeight: Number(getComputedStyle(label).fontWeight),
        statusFontSize: getComputedStyle(status).fontSize
      };
    });
    expect(compactTypography.rowFont.toLowerCase()).toContain("inter");
    expect(compactTypography.targetFont.toLowerCase()).toContain("inter");
    expect(compactTypography.targetHeight).toBeLessThan(24);
    expect(compactTypography.labelWeight).toBeGreaterThanOrEqual(600);
    expect(compactTypography.statusFontSize).toBe("12px");
    await writeTool.getByRole("button").click();
    await expect(writeTool).toContainText("INPUT");
    await expect(writeTool).toContainText("OUTPUT");
    const toolDetailsLayout = await writeTool.locator(".tool-run-details").evaluate((element) => {
      const rows = Array.from(element.querySelectorAll(":scope > div"));
      return rows.map((row) => {
        const label = row.querySelector("small");
        const pre = row.querySelector("pre");
        const labelRect = label?.getBoundingClientRect();
        const preRect = pre?.getBoundingClientRect();
        return {
          labelLeft: Math.round(labelRect?.left ?? 0),
          preLeft: Math.round(preRect?.left ?? 0),
          preWidth: Math.round(preRect?.width ?? 0),
          labelAlign: label ? getComputedStyle(label).textAlign : "",
          preAlign: pre ? getComputedStyle(pre).textAlign : ""
        };
      });
    });
    expect(toolDetailsLayout.length).toBeGreaterThanOrEqual(2);
    for (const item of toolDetailsLayout) {
      expect(Math.abs(item.preLeft - item.labelLeft)).toBeLessThanOrEqual(2);
      expect(item.preWidth).toBeGreaterThan(520);
      expect(item.labelAlign).toBe("left");
      expect(item.preAlign).toBe("start");
    }
  });

  test("assistant tool timeline summarizes edit, bash, and decoded errors", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("show edit timeline");
    await page.getByRole("button", { name: "Send" }).click();
    const editMessage = await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await expandWorkDetails(editMessage);
    const editTool = editMessage.locator(".tool-run-item", { hasText: "src/example.ts" });
    await expect(editTool).toContainText("edit");
    await expect(editTool).toContainText("edited - +1 -1");

    await page.locator(".rich-composer-editor").fill("show bash timeline");
    await page.getByRole("button", { name: "Send" }).click();
    const bashMessage = await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await expandWorkDetails(bashMessage);
    const bashTool = bashMessage.locator(".tool-run-item", { hasText: "ls src/renderer/components/chat" });
    await expect(bashTool).toContainText("bash");
    await expect(bashTool).toContainText("done - 3 lines");
    await expect(bashTool).not.toContainText("MessageTimeline.tsx");
    const bashToggle = bashTool.locator(".tool-run-toggle");
    await expect(bashToggle).toHaveAttribute("aria-expanded", "false");
    await bashToggle.click();
    await expect(bashToggle).toHaveAttribute("aria-expanded", "true");
    await expect(bashTool).toContainText("COMMAND");
    await expect(bashTool).toContainText("MessageTimeline.tsx");

    await page.locator(".rich-composer-editor").fill("show bash error timeline");
    await page.getByRole("button", { name: "Send" }).click();
    const errorMessage = await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await expandWorkDetails(errorMessage);
    const errorTool = errorMessage.locator(".tool-run-item.error");
    await expect(errorTool).toContainText("exit 1");
    await expect(errorTool).toContainText("Output encoding could not be decoded.");
    const errorToggle = errorTool.locator(".tool-run-toggle");
    await expect(errorToggle).toHaveAttribute("aria-expanded", "true");
    await errorToggle.click();
    await expect(errorToggle).toHaveAttribute("aria-expanded", "false");
    await expect(errorTool).not.toContainText("Output encoding could not be decoded.");
    await expect(errorTool).not.toContainText("����");
  });

  test("assistant markdown renders as structure instead of raw markdown text @smoke", async () => {
    const { app, page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("return markdown sample");
    await page.getByRole("button", { name: "Send" }).click();

    const message = page.locator(".assistant-block").last();
    await expect(message.locator(".markdown-heading")).toContainText("Markdown sample");
    await expect(message.locator(".markdown-message p strong")).toContainText("bold");
    await expect(message.locator(".markdown-message a")).toHaveAttribute("href", "https://example.com");
    await expect(message.locator(".markdown-message li")).toHaveCount(2);
    await expect(message.locator(".markdown-message li code")).toContainText("inline code");
    await expect(message.locator(".markdown-message table")).toBeVisible();
    await expect(message.locator(".markdown-message th").first()).toContainText("Item");
    await expect(message.locator(".markdown-message td").first()).toContainText("Table support");
    const codeBlock = message.locator(".markdown-message .code-block").first();
    await expect(codeBlock.getByRole("button", { name: "Copy code block" })).toBeVisible();
    await expect(codeBlock.locator("pre.shiki.github-light")).toBeVisible();
    await expect(codeBlock.locator(".line").first()).toContainText("const");
    await expect(codeBlock).toContainText("abcdefghijklmnopqrstuvwxyz");
    const syntaxPalette = await codeBlock.locator("pre.shiki").evaluate((pre) => {
      const tokens = Array.from(pre.querySelectorAll("span[style]")) as HTMLElement[];
      const keyword = tokens.find((token) => token.textContent === "const");
      const string = tokens.find((token) => token.textContent?.includes("abcdefghijklmnopqrstuvwxyz"));
      return {
        background: getComputedStyle(pre).backgroundColor,
        keyword: keyword ? getComputedStyle(keyword).color : "",
        string: string ? getComputedStyle(string).color : ""
      };
    });
    // Exact shiki token RGB values live in the visual harness; here we assert highlighting is
    // applied by checking keyword and string tokens render distinct, non-empty colors.
    expect(syntaxPalette.keyword).not.toBe("");
    expect(syntaxPalette.string).not.toBe("");
    expect(syntaxPalette.keyword).not.toBe(syntaxPalette.string);
    await expect.poll(() => codeBlock.locator(".code-block-scroll").evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    const twoslashBlock = message.locator(".markdown-message .code-block").nth(1);
    await expect(twoslashBlock.locator("pre.twoslash.lsp")).toBeVisible();
    await expect(twoslashBlock.locator("figcaption")).toContainText("types.ts");
    await expect(twoslashBlock.locator(".twoslash-query-line")).toContainText("string");
    await expect(twoslashBlock.locator(".twoslash-hover").first()).toBeVisible();
    const composerBox = await page.locator(".composer").boundingBox();
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(composerBox).not.toBeNull();
    expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(viewportHeight);

    await codeBlock.getByRole("button", { name: "Copy code block" }).click();
    await expect(page.locator(".toast")).toHaveText("Code copied");

    await message.getByRole("button", { name: "Message actions" }).click();
    const menuBox = await page.locator(".message-menu").boundingBox();
    const composerBeforeResize = await page.locator(".composer").boundingBox();
    expect(menuBox).not.toBeNull();
    expect(composerBeforeResize).not.toBeNull();
    expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual((composerBeforeResize?.y ?? 0) + 1);
    await page.keyboard.press("Escape");

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(920, 660);
    });
    const narrowRects = await codeBlock.evaluate((block) => {
      const button = block.querySelector("button");
      const preRect = block.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      return {
        preRight: preRect.right,
        preBottom: preRect.bottom,
        buttonRight: buttonRect?.right ?? Number.POSITIVE_INFINITY,
        buttonBottom: buttonRect?.bottom ?? Number.POSITIVE_INFINITY
      };
    });
    expect(narrowRects.buttonRight).toBeLessThanOrEqual(narrowRects.preRight + 1);
    expect(narrowRects.buttonBottom).toBeLessThanOrEqual(narrowRects.preBottom + 1);

    await expect(message).not.toContainText("**bold**");
    await expect(message).not.toContainText("- First point");
  });

  test("long assistant answers scroll without moving the composer", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("return long answer");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Long answer paragraph 42");

    await expect.poll(() => page.locator(".message-scroll").evaluate((node) => (
      node.scrollHeight > node.clientHeight + 100
    ))).toBe(true);

    const scrollMetrics = await page.locator(".message-scroll").evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      bottom: node.getBoundingClientRect().bottom
    }));
    const composerBox = await page.locator(".composer").boundingBox();
    const viewportHeight = await page.evaluate(() => window.innerHeight);

    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight + 100);
    expect(composerBox).not.toBeNull();
    expect((composerBox?.y ?? 0)).toBeGreaterThanOrEqual(scrollMetrics.bottom - 1);
    expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(viewportHeight);
  });

  test("image messages render thumbnails instead of path-only text", async () => {
    const { page } = harness;
    const imagePath = await createRedSquarePng(harness.userDataDir);
    const previewDataUrl = `data:image/png;base64,${RED_SQUARE_BASE64}`;

    await page.evaluate(
      async ({ imagePath: pathValue, preview }) => {
        const provider = (await window.jasmine.listProviders())[0];
        await window.jasmine.updateProviderModel({
          providerId: provider.id,
          modelId: provider.defaultModel,
          enabled: true,
          capabilities: { vision: true }
        });
        const thread = await window.jasmine.createThread({ title: "Image thumbnail E2E" });
        await window.jasmine.sendChatMessage({
          threadId: thread.id,
          providerId: provider.id,
          messages: [],
          content: "What color is this image?",
          attachments: [
            {
              name: "red-square.png",
              path: pathValue,
              kind: "file",
              mediaType: "image/png",
              isImage: true,
              previewDataUrl: preview
            }
          ]
        });
      },
      { imagePath, preview: previewDataUrl }
    );

    await page.reload();
    await page.getByRole("button", { name: /What color is this image/ }).click();

    await expect(page.locator(".message-image-grid img")).toHaveCount(1);
    await page.getByRole("button", { name: "Preview red-square.png" }).click();
    await expect(page.locator(".image-lightbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".image-lightbox")).toBeHidden();
    await expect(page.locator(".user-bubble").last()).not.toContainText(imagePath);
    await expect(page.locator(".assistant-block")).toContainText("Mock reply received 1 image attachment.");
  });
});

async function expandWorkDetails(assistant: Locator): Promise<void> {
  const toggle = assistant.getByRole("button", { name: "Show work details" });
  if (await toggle.isVisible()) await toggle.click();
  await expect(assistant.locator(".run-recap-details")).toBeVisible();
}
