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

  test("assistant timeline renders chronological thinking, tool calls, results, and output", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("show timeline tool call");
    await page.getByRole("button", { name: "Send" }).click();

    const latestAssistant = await waitForStableAssistant(page, "Mock reply from Jasmine.");
    // The answer survives the fold; the activity behind it does not show until
    // the reader asks for it.
    await expect(latestAssistant.getByLabel("Assistant output")).toContainText("Mock reply from Jasmine.");
    const runHeader = latestAssistant.locator(".run-header-toggle");
    await expect(runHeader).toContainText("Worked for");
    await expect(runHeader).toContainText("deepseek-v4-flash");
    await expect(latestAssistant.locator(".thinking-item")).toBeHidden();
    await runHeader.click();

    const thinkingItem = latestAssistant.locator(".thinking-item").first();
    await expect(thinkingItem).toBeVisible();
    await expect(thinkingItem).toContainText("Need to inspect");
    await expect(latestAssistant.locator(".message-timeline")).not.toContainText("Thinking level");
    const readTool = latestAssistant.locator(".tool-run-item", { hasText: "AGENTS.md" });
    const readDetails = readTool.locator(".tool-run-card");
    await expect(readTool).toContainText("Read");
    // Success says nothing: no status word, no line count on the row.
    await expect(readTool).not.toContainText("read -");
    await expect(readTool).not.toContainText("1 line");

    const thinkingToggle = latestAssistant.getByRole("button", { name: "Thinking", exact: true });
    await expect(thinkingToggle).toHaveAttribute("aria-expanded", "false");
    await expect(thinkingItem.locator(".timeline-row-thought")).toHaveCount(0);
    await thinkingToggle.click();
    await expect(thinkingToggle).toHaveAttribute("aria-expanded", "true");
    await expect(latestAssistant.locator(".thinking-item")).toContainText("Need to inspect");
    await expect(latestAssistant.locator(".timeline-row-thought .markdown-message")).toContainText("Need to inspect");

    const toolToggle = readTool.getByRole("button");
    await expect(toolToggle).toHaveAttribute("aria-expanded", "false");
    await expect(readDetails).toHaveCount(0);
    await toolToggle.click();
    await expect(toolToggle).toHaveAttribute("aria-expanded", "true");
    await expect(readDetails).toBeVisible();
    await expect(readTool).toContainText("IN");
    await expect(readTool).toContainText("OUT");
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
    const repairedHeader = repairedAssistant.locator(".run-header-toggle");
    await expect(repairedHeader).toContainText("Worked for 3m 49s");
    await expect(repairedHeader).toContainText("deepseek-v4-flash");
    await expect(repairedHeader).toContainText("high");
    await repairedHeader.click();
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

  test("pairs interleaved tool results and lazily mounts directly loaded tool details", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("show timeline interleaved tools");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await expect.poll(async () => page.evaluate(async () => (
      (await window.jasmine.listThreads()).some((thread) => thread.title.includes("show timeline interleaved tools"))
    ))).toBe(true);
    const threadTitle = await page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("show timeline interleaved tools"));
      if (!thread) throw new Error("Interleaved timeline thread missing.");
      return thread.title;
    });

    // Reload so the timeline is instantiated directly from its persisted,
    // settled message instead of retaining any live-stream component state.
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: threadTitle }).click();

    const latestAssistant = await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await latestAssistant.locator(".run-header-toggle").click();
    const readTool = latestAssistant.locator(".tool-run-item", { hasText: "document-analysis" }).first();
    const bashTool = latestAssistant.locator(".tool-run-item[data-tool-name='bash']").first();
    // Line counts and status words belong to the expanded output, not the row.
    await expect(readTool).not.toContainText("202 lines");
    await expect(bashTool).not.toContainText("15 lines");
    // The command is what the row is about, and it carries no credential
    // marker, so it reads in the summary rather than being withheld.
    await expect(bashTool).toContainText("ls -R");
    await expect(latestAssistant.locator(".tool-run-item.running")).toHaveCount(0);
    await expect(latestAssistant.locator(".timeline-row-state-text")).toHaveCount(0);

    // Real-layout regression: at the supported narrow window width with the
    // right panel open, an overlong target ellipsizes inside the row instead of
    // widening it. jsdom has no layout engine, so this can only live here.
    await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(840, 720));
    await page.getByRole("button", { name: "Open Artifacts" }).click();
    await expect(page.getByRole("complementary", { name: "Artifacts" })).toBeVisible();
    const longTarget = `C:\\workspace\\${"deeply-nested-segment\\".repeat(12)}document-analysis\\SKILL.md`;
    await readTool.locator(".timeline-row-summary").evaluate((node, text) => {
      node.textContent = text;
    }, longTarget);
    const narrowGeometry = await readTool.locator(".timeline-row").evaluate((row) => {
      const summary = row.querySelector<HTMLElement>(".timeline-row-summary");
      const title = row.querySelector<HTMLElement>(".timeline-row-title");
      const bounds = row.getBoundingClientRect();
      if (!summary || !title) throw new Error("Narrow tool row geometry missing.");
      return {
        clientWidth: row.clientWidth,
        scrollWidth: row.scrollWidth,
        rowHeight: bounds.height,
        right: bounds.right,
        summaryRight: summary.getBoundingClientRect().right,
        titleWidth: title.getBoundingClientRect().width,
        summaryClientWidth: summary.clientWidth,
        summaryScrollWidth: summary.scrollWidth
      };
    });
    expect(narrowGeometry.summaryScrollWidth).toBeGreaterThan(narrowGeometry.summaryClientWidth);
    expect(narrowGeometry.scrollWidth).toBeLessThanOrEqual(narrowGeometry.clientWidth + 1);
    expect(narrowGeometry.summaryRight).toBeLessThanOrEqual(narrowGeometry.right + 1);
    // The title never gives up space to the summary, and a collapsed row is
    // exactly one line however long its target is.
    expect(narrowGeometry.titleWidth).toBeGreaterThan(0);
    expect(narrowGeometry.rowHeight).toBe(24);
    await page.getByRole("button", { name: "Collapse panel" }).click();
    await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1200, 800));

    const toolToggle = readTool.getByRole("button");
    const details = readTool.locator(".timeline-row-body");
    const codeBlocks = readTool.locator(".shiki-code-block");
    const toolOutput = Array.from({ length: 202 }, (_entry, index) => `skill line ${index + 1}`).join("\n");
    await expect(toolToggle).toHaveAttribute("aria-expanded", "false");
    await expect(details).toHaveCount(0);
    await expect(codeBlocks).toHaveCount(0);
    await expect(readTool.locator(".shiki")).toHaveCount(0);

    await toolToggle.click();
    await expect(toolToggle).toHaveAttribute("aria-expanded", "true");
    await expect(details).toBeVisible();
    await expect(codeBlocks).toHaveCount(2);
    const outputBlock = readTool.locator(".shiki-code-block[data-language='markdown']");
    await expect(outputBlock).toHaveAttribute("data-code-length", String(toolOutput.length));
    await expect(outputBlock).toHaveAttribute("data-highlighted-length", String(toolOutput.length), { timeout: 15_000 });
    await details.evaluate((node) => {
      const scope = window as Window & {
        __JASMINE_LAZY_TOOL_DETAILS_NODE__?: Element;
        __JASMINE_LAZY_TOOL_CODE_NODE__?: Element;
      };
      scope.__JASMINE_LAZY_TOOL_DETAILS_NODE__ = node;
      scope.__JASMINE_LAZY_TOOL_CODE_NODE__ = node.querySelector(".shiki-code-block[data-language='markdown']") ?? undefined;
    });

    await toolToggle.click();
    await expect(toolToggle).toHaveAttribute("aria-expanded", "false");
    await expect(details).toHaveCount(1);
    await expect(details).toBeHidden();
    await expect(codeBlocks).toHaveCount(2);
    expect(await readTool.evaluate((row) => {
      const scope = window as Window & {
        __JASMINE_LAZY_TOOL_DETAILS_NODE__?: Element;
        __JASMINE_LAZY_TOOL_CODE_NODE__?: Element;
      };
      return scope.__JASMINE_LAZY_TOOL_DETAILS_NODE__ === row?.querySelector(".timeline-row-body")
        && scope.__JASMINE_LAZY_TOOL_CODE_NODE__ === row?.querySelector(".shiki-code-block[data-language='markdown']");
    })).toBe(true);

    const bashToggle = bashTool.getByRole("button");
    await expect(bashTool.locator(".tool-run-card")).toHaveCount(0);
    await bashToggle.click();
    await expect(bashTool.locator(".tool-run-card")).toContainText("ls -R");
  });

  test("expanded thinking markdown stays in one left-aligned column", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("show rich thinking timeline");
    await page.getByRole("button", { name: "Send" }).click();

    const latestAssistant = await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await latestAssistant.locator(".run-header-toggle").click();
    const thinkingToggle = latestAssistant.getByRole("button", { name: "Thinking", exact: true });
    await expect(thinkingToggle).toHaveAttribute("aria-expanded", "false");
    await thinkingToggle.click();
    await expect(thinkingToggle).toHaveAttribute("aria-expanded", "true");
    const thinkingMarkdown = latestAssistant.locator(".timeline-row-thought .markdown-message");
    await expect(thinkingMarkdown).toBeVisible();
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
    // Wait for streaming to finish before reading computed styles: the live
    // message re-renders on stream completion and can detach the measured row,
    // which makes getComputedStyle return empty values.
    await expect(page.locator(".assistant-block.live-message")).toHaveCount(0, { timeout: 10_000 });
    await writeMessage.locator(".run-header-toggle").click();
    const writeTool = writeMessage.locator(".tool-run-item", { hasText: "src/example.ts" });
    const writeDetails = writeTool.locator(".timeline-row-body");
    await expect(writeTool).toContainText("Write");
    // The row names the file it wrote and how much it wrote. The byte total is
    // inspection detail and stays in the expanded output.
    await expect(writeTool.locator(".timeline-row-suffix")).toHaveText("+4");
    await expect(writeTool).not.toContainText("44 bytes");
    await expect(writeTool).not.toContainText("wrote");
    await expect(writeDetails).toHaveCount(0);

    const rowTypography = await writeTool.locator(".timeline-row").evaluate((row) => {
      const title = row.querySelector(".timeline-row-title");
      const summary = row.querySelector(".timeline-row-summary");
      if (!(title instanceof HTMLElement) || !(summary instanceof HTMLElement)) {
        throw new Error("Tool row typography nodes missing.");
      }
      return {
        rowFont: getComputedStyle(row).fontFamily,
        rowHeight: row.getBoundingClientRect().height,
        titleSize: getComputedStyle(title).fontSize,
        titleWeight: Number(getComputedStyle(title).fontWeight),
        summarySize: getComputedStyle(summary).fontSize,
        summaryBackground: getComputedStyle(summary).backgroundColor
      };
    });
    expect(rowTypography.rowFont.toLowerCase()).toContain("inter");
    expect(rowTypography.rowHeight).toBe(24);
    // One type size across the row: title and summary differ by colour, not by
    // size or weight, and the target carries no pill background.
    expect(rowTypography.titleSize).toBe("14px");
    expect(rowTypography.summarySize).toBe("14px");
    expect(rowTypography.titleWeight).toBeLessThan(600);
    expect(rowTypography.summaryBackground).toBe("rgba(0, 0, 0, 0)");

    // The single content axis: the run header, every activity row's leading
    // icon, the answer, and the action icons all start at one left edge, and
    // an expanded body indents from it by exactly the 22px title offset.
    const axis = await writeMessage.evaluate((block) => {
      const left = (selector: string) => {
        const node = block.querySelector(selector);
        if (!node) throw new Error(`Content axis node missing: ${selector}`);
        return node.getBoundingClientRect().left;
      };
      return {
        header: left(".run-header-toggle"),
        rowLead: left(".tool-run-item .timeline-row-lead"),
        thinkingLead: left(".thinking-item .timeline-row-lead"),
        answer: left(".timeline-output p"),
        actionIcon: left(".message-actions .icon"),
        rowTitle: left(".tool-run-item .timeline-row-title")
      };
    });
    for (const edge of [axis.header, axis.rowLead, axis.thinkingLead, axis.actionIcon]) {
      expect(Math.abs(edge - axis.answer)).toBeLessThanOrEqual(2);
    }
    expect(Math.round(axis.rowTitle - axis.rowLead)).toBe(22);

    await writeTool.getByRole("button").click();
    await expect(writeDetails).toBeVisible();
    await expect(writeDetails).toContainText("Successfully wrote");
    await expect(writeDetails).toContainText("export function hello");
    // One card, two gutter-labelled slots. The gutter label is the only heading;
    // the code block's own caption bar must not repeat it.
    await expect(writeDetails.locator(".tool-run-card")).toHaveCount(1);
    await expect(writeDetails.locator("small", { hasText: "IN" }).first()).toBeVisible();
    await expect(writeDetails.locator("small", { hasText: "OUT" }).first()).toBeVisible();
    await expect(writeDetails.locator(".code-block figcaption:visible")).toHaveCount(0);
    const cardLayout = await writeTool.locator(".tool-run-card").evaluate((card) => {
      const row = card.closest(".tool-run-item");
      const titleLeft = row?.querySelector(".timeline-row-title")?.getBoundingClientRect().left ?? 0;
      const slots = Array.from(card.querySelectorAll(".tool-run-slot"));
      return {
        cardLeft: card.getBoundingClientRect().left,
        titleLeft,
        dividers: card.querySelectorAll(".tool-run-divider").length,
        slots: slots.map((slot) => {
          const label = slot.querySelector("small");
          const pre = slot.querySelector("pre");
          return {
            labelLeft: Math.round(label?.getBoundingClientRect().left ?? 0),
            preLeft: Math.round(pre?.getBoundingClientRect().left ?? 0),
            height: Math.round(slot.getBoundingClientRect().height)
          };
        })
      };
    });
    expect(cardLayout.slots.length).toBe(2);
    expect(cardLayout.dividers).toBe(1);
    // The card's left edge lands under the first character of its own row's
    // title — the 22px body indent, not some other inset.
    expect(Math.abs(cardLayout.cardLeft - cardLayout.titleLeft)).toBeLessThanOrEqual(1);
    for (const slot of cardLayout.slots) {
      // Gutter layout: the payload sits in a second column beside its label,
      // never under it, and each slot is capped so a long input cannot bury a
      // short output.
      expect(slot.preLeft).toBeGreaterThan(slot.labelLeft);
      expect(slot.height).toBeLessThanOrEqual(150);
    }
  });

  test("assistant markdown renders as structure instead of raw markdown text @smoke", async () => {
    const { app, page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("return markdown sample");
    await page.getByRole("button", { name: "Send" }).click();

    const latestMessage = page.locator(".assistant-block").last();
    await expect(latestMessage.locator(".markdown-heading")).toContainText("Markdown sample");
    await expect(page.locator(".assistant-block.live-message")).toHaveCount(0);
    const message = page.locator(".assistant-block:not(.live-message)").last();
    await expect(message.locator(".markdown-message p strong", { hasText: "bold" })).toHaveText("bold");
    const fontSample = message.locator(".markdown-message p", { hasText: "33632" });
    const boldNumber = fontSample.locator("strong", { hasText: "33632" });
    await expect(fontSample).toContainText("中文回退保持正常");
    await expect(boldNumber).toHaveText("33632");
    const fontEvidence = await boldNumber.evaluate(async (node) => {
      await document.fonts.ready;
      const loadedFaces = await document.fonts.load('700 15px "Jasmine Inter"', "33632");
      const style = getComputedStyle(node);
      return {
        family: style.fontFamily,
        weight: style.fontWeight,
        size: style.fontSize,
        synthesis: style.fontSynthesis,
        loadedFaces: loadedFaces.map((face) => ({
          family: face.family,
          style: face.style,
          weight: face.weight,
          status: face.status
        }))
      };
    });
    expect(fontEvidence.family).toMatch(/^"Jasmine Inter", ui-sans-serif, system-ui/);
    expect(fontEvidence.family).toContain('"Segoe UI"');
    expect(fontEvidence.weight).toBe("700");
    expect(fontEvidence.size).toBe("15px");
    expect(fontEvidence.synthesis.split(/\s+/)).not.toContain("weight");
    expect(fontEvidence.loadedFaces).toContainEqual({
      family: "Jasmine Inter",
      style: "normal",
      weight: "100 900",
      status: "loaded"
    });

    let platformFontEvidence: Array<{ familyName: string; isCustomFont: boolean; glyphCount: number }> = [];
    const cdp = await app.context().newCDPSession(page);
    try {
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const remote = await cdp.send("Runtime.evaluate", {
        expression: `Array.from(document.querySelectorAll(".assistant-block .markdown-message p")).find((node) => node.textContent?.includes("33632"))`,
        objectGroup: "jasmine-inter-proof"
      });
      expect(remote.exceptionDetails).toBeUndefined();
      if (!remote.result.objectId) throw new Error("Bold-number font sample was not available to CDP.");
      const { nodeId } = await cdp.send("DOM.requestNode", { objectId: remote.result.objectId });
      const platformFonts = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      platformFontEvidence = platformFonts.fonts.map((font) => ({
        familyName: font.familyName,
        isCustomFont: font.isCustomFont,
        glyphCount: font.glyphCount
      }));
      expect(platformFonts.fonts.some((font) => font.isCustomFont && /Inter/i.test(font.familyName))).toBe(true);
      expect(platformFonts.fonts.some((font) => !font.isCustomFont && font.glyphCount > 0)).toBe(true);
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup: "jasmine-inter-proof" });
    } finally {
      await cdp.detach();
    }

    const fontEvidenceDir = path.join(rootDir, "test-results", "ui-harness", "font");
    await mkdir(fontEvidenceDir, { recursive: true });
    await fontSample.screenshot({ path: path.join(fontEvidenceDir, "inter-bold-33632.png") });
    await writeFile(
      path.join(fontEvidenceDir, "inter-bold-33632.json"),
      `${JSON.stringify({ computed: fontEvidence, platformFonts: platformFontEvidence }, null, 2)}\n`,
      "utf8"
    );
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
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Smooth long answer fixture" }));
    seedLargeThreadMessages(harness.userDataDir, thread.id, 158);
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: "Smooth long answer fixture" }).first().click();
    await expect(page.locator("[data-message-id]")).toHaveCount(158);
    await expect.poll(() => page.locator(".message-scroll").evaluate((node) => (
      node.scrollHeight - node.scrollTop - node.clientHeight
    ))).toBeLessThanOrEqual(2);
    const settledIds = await page.locator("[data-message-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-message-id") ?? ""));
    await page.evaluate(() => {
      (window as Window & { __JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__?: Record<string, number> }).__JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__ = {};
    });

    await page.locator(".rich-composer-editor").fill("return long answer smooth stream");
    await page.getByRole("button", { name: "Send" }).click();
    const liveAssistant = page.locator(".assistant-block.live-message").last();
    await expect(liveAssistant).toBeVisible();
    await page.evaluate(() => {
      const harnessWindow = window as Window & {
        __JASMINE_LIVE_MESSAGE_NODE__?: Element;
        __JASMINE_PENDING_MESSAGE_NODE__?: Element;
        __JASMINE_STREAM_TAIL_OFFSETS__?: number[];
        __JASMINE_STREAM_SCROLL_TOP_SAMPLES__?: number[];
        __JASMINE_STOP_SCROLL_SAMPLING__?: boolean;
      };
      harnessWindow.__JASMINE_LIVE_MESSAGE_NODE__ = document.querySelector(".assistant-block.live-message:last-of-type") ?? undefined;
      harnessWindow.__JASMINE_PENDING_MESSAGE_NODE__ = document.querySelector("[data-message-id^='pending-']") ?? undefined;
      harnessWindow.__JASMINE_STREAM_TAIL_OFFSETS__ = [];
      harnessWindow.__JASMINE_STREAM_SCROLL_TOP_SAMPLES__ = [];
      harnessWindow.__JASMINE_STOP_SCROLL_SAMPLING__ = false;
      const scroll = document.querySelector<HTMLElement>(".message-scroll");
      const sample = () => {
        if (!scroll || harnessWindow.__JASMINE_STOP_SCROLL_SAMPLING__) return;
        const liveTail = document.querySelector(".assistant-block.live-message");
        if (liveTail) {
          harnessWindow.__JASMINE_STREAM_TAIL_OFFSETS__?.push(Math.max(0, liveTail.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom));
          harnessWindow.__JASMINE_STREAM_SCROLL_TOP_SAMPLES__?.push(scroll.scrollTop);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const textLengthBeforeBlockedFrame = await liveAssistant.evaluate((node) => node.textContent?.length ?? 0);
    await page.evaluate(() => {
      (window as Window & { __JASMINE_STREAM_TAIL_OFFSETS__?: number[] }).__JASMINE_STREAM_TAIL_OFFSETS__ = [];
    });
    // Model a long Markdown/Shiki frame while main-process stream updates keep
    // arriving. Publication should converge to the newest cumulative snapshot
    // on the next paint instead of replaying every missed prefix.
    await page.evaluate(() => {
      const blockedUntil = performance.now() + 180;
      let spin = 0;
      while (performance.now() < blockedUntil) spin += 1;
      void spin;
    });
    await expect.poll(() => liveAssistant.evaluate((node) => node.textContent?.length ?? 0)).toBeGreaterThan(textLengthBeforeBlockedFrame);
    await expect.poll(() => liveAssistant.evaluate((node) => {
      const scroll = document.querySelector<HTMLElement>(".message-scroll");
      if (!scroll) return Number.POSITIVE_INFINITY;
      return Math.max(0, node.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom);
    })).toBeLessThanOrEqual(17);
    const blockedFrameTailEnvelope = await page.evaluate(() => Math.max(
      0,
      ...((window as Window & { __JASMINE_STREAM_TAIL_OFFSETS__?: number[] }).__JASMINE_STREAM_TAIL_OFFSETS__ ?? [])
    ));
    // The first painted frame after the blocked interval must already pair the
    // coalesced newest text with a matching tail position. Replaying 16px catch-
    // up steps would expose a much larger offset in this rAF sample.
    expect(blockedFrameTailEnvelope).toBeLessThanOrEqual(17);
    // A renderer-blocked interval has no painted frames, so the amount of text
    // queued by the independent main-process stream is scheduler/platform
    // dependent. Begin the steady-state tail envelope after recovery.
    await page.evaluate(() => {
      (window as Window & { __JASMINE_STREAM_TAIL_OFFSETS__?: number[] }).__JASMINE_STREAM_TAIL_OFFSETS__ = [];
    });
    // CI runners can paint substantially below 60fps while the main-process
    // stream continues flushing. Model that steady low-frame-rate phase so the
    // follower must stay inside the visual envelope without exceeding its
    // per-painted-frame scroll budget.
    const steadyFrameSession = await page.context().newCDPSession(page);
    try {
      await steadyFrameSession.send("Emulation.setCPUThrottlingRate", { rate: 2 });
      await waitForStableAssistant(page, "Long answer paragraph 42");
      await expect.poll(() => page.locator(".message-scroll").evaluate((node) => (
        node.scrollHeight - node.scrollTop - node.clientHeight
      ))).toBeLessThanOrEqual(2);
    } finally {
      await steadyFrameSession.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
      await steadyFrameSession.detach().catch(() => undefined);
    }

    const streamingContinuity = await page.evaluate(() => {
      const harnessWindow = window as Window & {
        __JASMINE_LIVE_MESSAGE_NODE__?: Element;
        __JASMINE_PENDING_MESSAGE_NODE__?: Element;
        __JASMINE_STREAM_TAIL_OFFSETS__?: number[];
        __JASMINE_STREAM_SCROLL_TOP_SAMPLES__?: number[];
        __JASMINE_STOP_SCROLL_SAMPLING__?: boolean;
      };
      harnessWindow.__JASMINE_STOP_SCROLL_SAMPLING__ = true;
      const lastAssistant = document.querySelector(".assistant-block:last-of-type");
      const finalAnswer = lastAssistant?.querySelector(".final-answer");
      const finalRect = finalAnswer?.getBoundingClientRect();
      const scrollTops = harnessWindow.__JASMINE_STREAM_SCROLL_TOP_SAMPLES__ ?? [];
      let maxPaintedFrameAdvance = 0;
      for (let index = 1; index < scrollTops.length; index += 1) {
        maxPaintedFrameAdvance = Math.max(maxPaintedFrameAdvance, scrollTops[index] - scrollTops[index - 1]);
      }
      return {
        sameMessageNode: harnessWindow.__JASMINE_LIVE_MESSAGE_NODE__ === lastAssistant,
        sameUserNode: harnessWindow.__JASMINE_PENDING_MESSAGE_NODE__ === Array.from(document.querySelectorAll(".user-message-wrap")).at(-1),
        maxTailOffset: Math.max(0, ...(harnessWindow.__JASMINE_STREAM_TAIL_OFFSETS__ ?? [])),
        maxPaintedFrameAdvance,
        finalAnswerVisible: Boolean(finalRect && finalRect.bottom > 0 && finalRect.top < window.innerHeight),
        settledRenders: Object.fromEntries(Object.entries(harnessWindow.__JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__ ?? {})
          .filter(([id]) => id.startsWith("large-")))
      };
    });
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
    expect(streamingContinuity.sameMessageNode).toBe(true);
    expect(streamingContinuity.sameUserNode).toBe(true);
    expect(streamingContinuity.maxTailOffset).toBeLessThanOrEqual(17);
    expect(streamingContinuity.maxPaintedFrameAdvance).toBeGreaterThan(0);
    expect(streamingContinuity.finalAnswerVisible).toBe(true);
    expect(streamingContinuity.settledRenders).toEqual({});
    expect(settledIds).toHaveLength(158);
    expect(composerBox).not.toBeNull();
    expect((composerBox?.y ?? 0)).toBeGreaterThanOrEqual(scrollMetrics.bottom - 1);
    expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(viewportHeight);
  });

});
