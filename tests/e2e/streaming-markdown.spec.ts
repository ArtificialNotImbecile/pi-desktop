import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import {
  launchJasmine,
  quitElectron,
  type HarnessApp
} from "./helpers";

test.describe("Jasmine streaming Markdown", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("keeps completed prefix DOM stable and parses only the active tail of a long cumulative answer", async () => {
    const { app, page } = harness;
    const threadId = await activateFixtureThread(harness, "Incremental Markdown fixture");
    const requestId = "incremental-markdown-request";
    const initial = longMarkdown(40);
    const middle = longMarkdown(55);
    const complete = longMarkdown(70);
    expect(complete.length).toBeGreaterThan(15_000);

    await sendTimeline(app, {
      requestId,
      threadId,
      content: initial,
      timeline: [{ id: "long-markdown-output", kind: "assistant_text", text: initial }]
    });

    const live = page.locator(".assistant-block.live-message").last();
    await expect(live.locator(".markdown-heading").first()).toHaveText("Stable section 1");
    await expect(live.locator("[data-streaming-markdown='true']")).toBeVisible();
    // This case isolates incremental Markdown reconciliation, not tail-follow
    // pacing. Explicitly enter reading mode after the intentionally enormous
    // first snapshot so subsequent cumulative snapshots are not held behind
    // the smooth-scroll backlog tested in rendering.spec.ts.
    await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(".message-scroll");
      if (!scroll) throw new Error("Markdown fixture viewport is missing.");
      scroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }));
      scroll.scrollTop = Math.max(0, scroll.scrollTop - 120);
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_STABLE_MARKDOWN_PREFIX__?: Element;
        __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[];
      };
      scope.__JASMINE_STABLE_MARKDOWN_PREFIX__ = document.querySelector(".assistant-block.live-message .markdown-heading") ?? undefined;
      scope.__JASMINE_MARKDOWN_RENDER_LENGTHS__ = [];
    });

    await sendTimeline(app, {
      requestId,
      threadId,
      content: middle,
      timeline: [{ id: "long-markdown-output", kind: "assistant_text", text: middle }]
    });
    await expect(live.locator(".markdown-heading")).toHaveCount(55);

    await sendTimeline(app, {
      requestId,
      threadId,
      content: complete,
      timeline: [{ id: "long-markdown-output", kind: "assistant_text", text: complete }]
    });
    await expect(live.locator(".markdown-heading")).toHaveCount(70);
    await expect(live.locator("li")).toHaveCount(140);
    await expect(live.locator(".code-block")).toHaveCount(70);
    await expect(live.locator(".code-block").first()).toContainText("const section1 = 1;");

    const metrics = await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_STABLE_MARKDOWN_PREFIX__?: Element;
        __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[];
      };
      const lengths = scope.__JASMINE_MARKDOWN_RENDER_LENGTHS__ ?? [];
      return {
        prefixNodeStayedMounted: scope.__JASMINE_STABLE_MARKDOWN_PREFIX__ === document.querySelector(".assistant-block.live-message .markdown-heading"),
        largestParsedChunk: Math.max(0, ...lengths),
        parseCount: lengths.length
      };
    });
    expect(metrics.prefixNodeStayedMounted).toBe(true);
    expect(metrics.parseCount).toBeGreaterThan(0);
    expect(metrics.largestParsedChunk).toBeLessThan(3_000);
  });

  test("keeps final output and work rows mounted in place through settlement", async () => {
    const { app, page } = harness;
    const threadId = await activateFixtureThread(harness, "Settlement Markdown continuity fixture");
    const requestId = "settlement-markdown-request";
    const finalText = longMarkdown(70);
    const timeline = [
      { id: "settlement-model", kind: "system", title: "Model", text: "mock/deepseek-v4-flash" },
      { id: "settlement-preamble", kind: "assistant_text", text: "I will inspect the source first." },
      {
        id: "settlement-tool-call",
        kind: "tool_call",
        toolName: "read",
        title: "Read source",
        argumentsJson: JSON.stringify({ path: "src/example.ts" })
      },
      {
        id: "settlement-tool-result",
        kind: "tool_result",
        toolName: "read",
        title: "Read source",
        content: "export const example = true;"
      },
      { id: "settlement-final-output", kind: "assistant_text", text: finalText }
    ];

    await sendTimeline(app, {
      requestId,
      threadId,
      content: `I will inspect the source first.\n\n${finalText}`,
      timeline
    });

    const live = page.locator(".assistant-block.live-message").last();
    const liveFinalRow = live.locator("[data-timeline-item-id='settlement-final-output']");
    await expect(liveFinalRow.locator(".markdown-heading")).toHaveCount(70);
    await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_SETTLEMENT_OUTPUT_ROW__?: Element;
        __JASMINE_SETTLEMENT_PREFIX_NODE__?: Element;
        __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[];
      };
      scope.__JASMINE_SETTLEMENT_OUTPUT_ROW__ = document.querySelector("[data-timeline-item-id='settlement-final-output']") ?? undefined;
      scope.__JASMINE_SETTLEMENT_PREFIX_NODE__ = document.querySelector("[data-timeline-item-id='settlement-final-output'] .markdown-heading") ?? undefined;
      scope.__JASMINE_MARKDOWN_RENDER_LENGTHS__ = [];
    });

    await sendSettlement(app, {
      requestId,
      threadId,
      persistedId: "settlement-persisted-assistant",
      content: `I will inspect the source first.\n\n${finalText}`,
      timeline
    });

    const settled = page.locator("[data-message-id='settlement-persisted-assistant']");
    const settledFinalRow = settled.locator("[data-timeline-item-id='settlement-final-output']");
    await expect(settled).not.toHaveClass(/live-message/);
    await expect(settledFinalRow).toHaveClass(/final-answer/);
    await expect(settledFinalRow.locator(".markdown-heading")).toHaveCount(70);
    await expect(settled.locator(".run-recap")).toHaveCount(0);
    await expect(settled.locator("[data-timeline-item-id='settlement-preamble']")).toBeVisible();

    const continuity = await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_SETTLEMENT_OUTPUT_ROW__?: Element;
        __JASMINE_SETTLEMENT_PREFIX_NODE__?: Element;
        __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[];
      };
      const settledRow = document.querySelector("[data-timeline-item-id='settlement-final-output']");
      const settledPrefix = settledRow?.querySelector(".markdown-heading");
      const parsedLengths = scope.__JASMINE_MARKDOWN_RENDER_LENGTHS__ ?? [];
      return {
        sameOutputRow: scope.__JASMINE_SETTLEMENT_OUTPUT_ROW__ === settledRow,
        sameStablePrefix: scope.__JASMINE_SETTLEMENT_PREFIX_NODE__ === settledPrefix,
        completionParseCount: parsedLengths.length,
        largestCompletionParse: Math.max(0, ...parsedLengths)
      };
    });
    expect(continuity).toEqual({
      sameOutputRow: true,
      sameStablePrefix: true,
      completionParseCount: 0,
      largestCompletionParse: 0
    });

    await expect(settled.locator("[data-timeline-item-id='settlement-preamble']")).not.toHaveClass(/tool-preamble-item/);
    await expect(settled.locator(".tool-run-item", { hasText: "src/example.ts" })).toBeVisible();
    await expect(settledFinalRow).toContainText("Stable section 70");
  });

  test("commits a queued settlement before a hidden window can suspend animation frames", async () => {
    const { app, page } = harness;
    const threadId = await activateFixtureThread(harness, "Hidden settlement continuity fixture");
    const requestId = "hidden-settlement-request";
    const persistedId = "hidden-settlement-persisted";
    const initial = "Visible partial output before the window is hidden.";
    const finalText = "Canonical final output after the window is hidden.";
    const timeline = [{ id: "hidden-settlement-output", kind: "assistant_text", text: finalText }];

    await sendTimeline(app, {
      requestId,
      threadId,
      content: initial,
      timeline: [{ id: "hidden-settlement-output", kind: "assistant_text", text: initial }]
    });
    await expect(page.locator(".assistant-block.live-message")).toContainText(initial);

    // Queue the terminal IPC and hide the BrowserWindow in the same main-loop
    // turn. The renderer's visibility handler must replace any not-yet-painted
    // stream work with the canonical settlement instead of waiting for rAF.
    await app.evaluate(({ BrowserWindow }, payload) => {
      const mainWindow = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("index.html"));
      mainWindow?.webContents.send("chat:stream", {
        requestId: payload.requestId,
        threadId: payload.threadId,
        status: "done",
        settlement: {
          messages: [{
            id: payload.persistedId,
            renderId: `stream-${payload.requestId}-0`,
            threadId: payload.threadId,
            role: "assistant",
            content: payload.finalText,
            createdAt: new Date().toISOString(),
            timeline: payload.timeline
          }]
        }
      });
      mainWindow?.hide();
    }, { requestId, threadId, persistedId, finalText, timeline });

    await expect.poll(() => page.evaluate((id) => {
      const message = document.querySelector<HTMLElement>(`[data-message-id='${id}']`);
      return {
        text: message?.textContent ?? "",
        liveCount: document.querySelectorAll(".assistant-block.live-message").length
      };
    }, persistedId)).toEqual({ text: expect.stringContaining(finalText), liveCount: 0 });

    await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("index.html"));
      mainWindow?.showInactive();
    });
    await expect(page.locator(`[data-message-id='${persistedId}']`)).toContainText(finalText);
    await expect(page.locator(".assistant-block.live-message")).toHaveCount(0);
  });

  test("pairs out-of-order same-name tool results by tool call id", async () => {
    const { app, page } = harness;
    const threadId = await activateFixtureThread(harness, "Parallel tool correlation fixture");
    const requestId = "parallel-tool-correlation-request";
    const calls = [
      {
        id: "parallel-read-a-row",
        kind: "tool_call",
        toolCallId: "parallel-read-a",
        toolName: "read",
        title: "Read first source",
        argumentsJson: JSON.stringify({ path: "src/first.ts" })
      },
      {
        id: "parallel-read-b-row",
        kind: "tool_call",
        toolCallId: "parallel-read-b",
        toolName: "read",
        title: "Read second source",
        argumentsJson: JSON.stringify({ path: "src/second.ts" })
      }
    ];
    const resultB = {
      id: "parallel-read-b-result",
      kind: "tool_result",
      toolCallId: "parallel-read-b",
      toolName: "read",
      title: "Read second source",
      content: "SECOND_TOOL_RESULT_SENTINEL"
    };
    const resultA = {
      id: "parallel-read-a-result",
      kind: "tool_result",
      toolCallId: "parallel-read-a",
      toolName: "read",
      title: "Read first source",
      content: "FIRST_TOOL_RESULT_SENTINEL"
    };

    await sendTimeline(app, { requestId, threadId, content: "", timeline: calls });
    const live = page.locator(".assistant-block.live-message").last();
    const first = live.locator("[data-timeline-item-id='parallel-read-a-row']");
    const second = live.locator("[data-timeline-item-id='parallel-read-b-row']");
    await expect(first).toHaveClass(/running/);
    await expect(second).toHaveClass(/running/);

    await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_PARALLEL_CALL_A__?: Element;
        __JASMINE_PARALLEL_CALL_B__?: Element;
      };
      scope.__JASMINE_PARALLEL_CALL_A__ = document.querySelector("[data-timeline-item-id='parallel-read-a-row']") ?? undefined;
      scope.__JASMINE_PARALLEL_CALL_B__ = document.querySelector("[data-timeline-item-id='parallel-read-b-row']") ?? undefined;
    });

    // The second call completes first, but its provider correlation id arrives
    // one snapshot late. While ambiguous, the result must stand alone: name-only
    // FIFO matching would briefly mark the first row done and paint B's output
    // under src/first.ts before visibly moving it on the next snapshot.
    const uncorrelatedResultB = { ...resultB, toolCallId: undefined };
    await sendTimeline(app, { requestId, threadId, content: "", timeline: [...calls, uncorrelatedResultB] });
    await expect(first).toHaveClass(/running/);
    await expect(second).toHaveClass(/running/);
    const independentResult = live.locator("[data-timeline-item-id='parallel-read-b-result']");
    await expect(independentResult).toHaveClass(/done/);
    await independentResult.getByRole("button").click();
    await expect(independentResult).toContainText("SECOND_TOOL_RESULT_SENTINEL");
    await expect(first).not.toContainText("SECOND_TOOL_RESULT_SENTINEL");
    await expect(second).not.toContainText("SECOND_TOOL_RESULT_SENTINEL");

    // Once call-b arrives, fold the result into B without remounting either
    // already-painted call row.
    await sendTimeline(app, { requestId, threadId, content: "", timeline: [...calls, resultB] });
    await expect(first).toHaveClass(/running/);
    await expect(second).toHaveClass(/done/);
    await expect(independentResult).toHaveCount(0);
    await second.getByRole("button").click();
    await expect(second).toContainText("SECOND_TOOL_RESULT_SENTINEL");
    await expect(second).not.toContainText("FIRST_TOOL_RESULT_SENTINEL");
    expect(await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_PARALLEL_CALL_A__?: Element;
        __JASMINE_PARALLEL_CALL_B__?: Element;
      };
      return scope.__JASMINE_PARALLEL_CALL_A__ === document.querySelector("[data-timeline-item-id='parallel-read-a-row']")
        && scope.__JASMINE_PARALLEL_CALL_B__ === document.querySelector("[data-timeline-item-id='parallel-read-b-row']");
    })).toBe(true);

    await sendTimeline(app, { requestId, threadId, content: "", timeline: [...calls, resultB, resultA] });
    await expect(first).toHaveClass(/done/);
    await expect(second).toHaveClass(/done/);
    await first.getByRole("button").click();
    await expect(first).toContainText("FIRST_TOOL_RESULT_SENTINEL");
    await expect(first).not.toContainText("SECOND_TOOL_RESULT_SENTINEL");
    await expect(second).toContainText("SECOND_TOOL_RESULT_SENTINEL");
  });

  test("keeps a wheel-locked live tool row visually anchored through settlement", async () => {
    const { app, page } = harness;
    const threadId = await activateFixtureThread(harness, "Locked settlement reading fixture");
    const requestId = "locked-settlement-reading-request";
    const persistedId = "locked-settlement-persisted-assistant";
    const targetItemId = "locked-reading-tool-call";
    const toolOutput = Array.from(
      { length: 260 },
      (_entry, index) => `export const inspectedLine${index + 1} = ${index + 1};`
    ).join("\n");
    const finalText = longMarkdown(18);
    const timeline = [
      { id: "locked-reading-model", kind: "system", title: "Model", text: "mock/deepseek-v4-flash" },
      { id: "locked-reading-thinking-before", kind: "thinking", text: longMarkdown(24) },
      {
        id: targetItemId,
        kind: "tool_call",
        toolName: "read",
        title: "Read long source",
        argumentsJson: JSON.stringify({ path: "src/long-example.ts" })
      },
      {
        id: "locked-reading-tool-result",
        kind: "tool_result",
        toolName: "read",
        title: "Read long source",
        content: toolOutput
      },
      { id: "locked-reading-thinking-after", kind: "thinking", text: longMarkdown(12) },
      { id: "locked-reading-final-output", kind: "assistant_text", text: finalText }
    ];

    await sendTimeline(app, {
      requestId,
      threadId,
      content: finalText,
      timeline
    });

    const live = page.locator(".assistant-block.live-message").last();
    const target = live.locator(`[data-timeline-item-id='${targetItemId}']`);
    const targetToggle = target.getByRole("button");
    await expect(target).toBeVisible();
    await targetToggle.click();
    await expect(targetToggle).toHaveAttribute("aria-expanded", "true");
    await expect(target).toContainText("inspectedLine260");

    // Put the expanded tool body just above the viewport edge, then model a
    // genuine upward wheel intent. The target becomes the first visible stable
    // timeline row, which is exactly the anchor the product captures.
    await page.evaluate(({ itemId }) => {
      const scroll = document.querySelector<HTMLElement>(".message-scroll");
      const row = document.querySelector<HTMLElement>(`[data-timeline-item-id='${itemId}']`);
      if (!scroll || !row) throw new Error("Reading fixture was not rendered");
      const scrollRect = scroll.getBoundingClientRect();
      const rowContentTop = row.getBoundingClientRect().top - scrollRect.top + scroll.scrollTop;
      scroll.scrollTop = rowContentTop + 180;
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
      scroll.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }));
      scroll.scrollTop -= 120;
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, { itemId: targetItemId });
    await waitAnimationFrames(page, 3);

    const lockedReadingPosition = await page.evaluate((itemId) => {
      const scroll = document.querySelector<HTMLElement>(".message-scroll");
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-timeline-item-id]:not([hidden])"));
      if (!scroll) throw new Error("Message viewport was not rendered");
      const scrollRect = scroll.getBoundingClientRect();
      const firstVisible = rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > scrollRect.top && rect.top < scrollRect.bottom;
      });
      const targetRow = rows.find((row) => row.dataset.timelineItemId === itemId);
      const targetRect = targetRow?.getBoundingClientRect();
      return {
        firstVisibleItemId: firstVisible?.dataset.timelineItemId ?? null,
        targetViewportTop: targetRect ? targetRect.top - scrollRect.top : null,
        targetVisible: Boolean(targetRect && targetRect.bottom > scrollRect.top && targetRect.top < scrollRect.bottom)
      };
    }, targetItemId);
    expect(lockedReadingPosition.firstVisibleItemId).toBe(targetItemId);
    expect(lockedReadingPosition.targetVisible).toBe(true);
    expect(lockedReadingPosition.targetViewportTop).not.toBeNull();

    await page.evaluate(({ itemId, persistedMessageId }) => {
      type ReadingSample = {
        top: number | null;
        visible: boolean;
        sameNode: boolean;
        settled: boolean;
        rowExpanded: boolean | null;
      };
      const scope = window as Window & {
        __JASMINE_LOCKED_READING_ROW__?: Element;
        __JASMINE_LOCKED_READING_BASELINE__?: number;
        __JASMINE_LOCKED_READING_SAMPLES__?: ReadingSample[];
        __JASMINE_LOCKED_READING_ACTIVE__?: boolean;
      };
      const selector = `[data-timeline-item-id='${itemId}']`;
      const row = document.querySelector<HTMLElement>(selector);
      const scroll = document.querySelector<HTMLElement>(".message-scroll");
      if (!row || !scroll) throw new Error("Locked reading row was not rendered");
      scope.__JASMINE_LOCKED_READING_ROW__ = row;
      scope.__JASMINE_LOCKED_READING_BASELINE__ = row.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      scope.__JASMINE_LOCKED_READING_SAMPLES__ = [];
      scope.__JASMINE_LOCKED_READING_ACTIVE__ = true;

      const sample = () => {
        const current = document.querySelector<HTMLElement>(selector);
        const viewport = document.querySelector<HTMLElement>(".message-scroll");
        const rowRect = current?.getBoundingClientRect();
        const viewportRect = viewport?.getBoundingClientRect();
        const message = current?.closest<HTMLElement>(".assistant-block");
        const rowToggle = current?.querySelector<HTMLElement>(".timeline-toggle");
        scope.__JASMINE_LOCKED_READING_SAMPLES__?.push({
          top: rowRect && viewportRect ? rowRect.top - viewportRect.top : null,
          visible: Boolean(rowRect && viewportRect && rowRect.bottom > viewportRect.top && rowRect.top < viewportRect.bottom),
          sameNode: current === scope.__JASMINE_LOCKED_READING_ROW__,
          settled: message?.dataset.messageId === persistedMessageId,
          rowExpanded: rowToggle ? rowToggle.getAttribute("aria-expanded") === "true" : null
        });
        if (scope.__JASMINE_LOCKED_READING_ACTIVE__ && (scope.__JASMINE_LOCKED_READING_SAMPLES__?.length ?? 0) < 240) {
          window.requestAnimationFrame(sample);
        }
      };
      window.requestAnimationFrame(sample);
    }, { itemId: targetItemId, persistedMessageId: persistedId });
    await waitAnimationFrames(page, 3);

    await sendSettlement(app, {
      requestId,
      threadId,
      persistedId,
      content: finalText,
      timeline
    });

    const settled = page.locator(`[data-message-id='${persistedId}']`);
    const settledTarget = settled.locator(`[data-timeline-item-id='${targetItemId}']`);
    await expect(settled).not.toHaveClass(/live-message/);
    await expect(settled.locator(".run-recap")).toHaveCount(0);
    await expect(settledTarget).toBeVisible();
    await expect(settledTarget.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    await waitAnimationFrames(page, 12);

    const stability = await page.evaluate(() => {
      type ReadingSample = {
        top: number | null;
        visible: boolean;
        sameNode: boolean;
        settled: boolean;
        rowExpanded: boolean | null;
      };
      const scope = window as Window & {
        __JASMINE_LOCKED_READING_BASELINE__?: number;
        __JASMINE_LOCKED_READING_SAMPLES__?: ReadingSample[];
        __JASMINE_LOCKED_READING_ACTIVE__?: boolean;
      };
      scope.__JASMINE_LOCKED_READING_ACTIVE__ = false;
      const baseline = scope.__JASMINE_LOCKED_READING_BASELINE__ ?? Number.NaN;
      const samples = scope.__JASMINE_LOCKED_READING_SAMPLES__ ?? [];
      const firstSettledIndex = samples.findIndex((sample) => sample.settled);
      const transitionSamples = firstSettledIndex < 0 ? [] : samples.slice(Math.max(0, firstSettledIndex - 1));
      const settledSamples = samples.filter((sample) => sample.settled);
      const numericSettledTops = settledSamples.flatMap((sample) => sample.top === null ? [] : [sample.top]);
      const finalTops = numericSettledTops.slice(-6);
      return {
        settledSampleCount: settledSamples.length,
        everySettledSampleVisible: settledSamples.every((sample) => sample.visible),
        everySettledSampleKeptNode: settledSamples.every((sample) => sample.sameNode),
        everySettledSampleKeptRowExpanded: settledSamples.every((sample) => sample.rowExpanded === true),
        maxBaselineDrift: Math.max(0, ...numericSettledTops.map((top) => Math.abs(top - baseline))),
        maxFrameDrift: Math.max(0, ...transitionSamples.slice(1).map((sample, index) => {
          const previous = transitionSamples[index];
          return sample.top === null || previous.top === null ? Number.POSITIVE_INFINITY : Math.abs(sample.top - previous.top);
        })),
        finalTopRange: finalTops.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...finalTops) - Math.min(...finalTops)
      };
    });
    expect(stability.settledSampleCount).toBeGreaterThanOrEqual(6);
    expect(stability.everySettledSampleVisible).toBe(true);
    expect(stability.everySettledSampleKeptNode).toBe(true);
    expect(stability.everySettledSampleKeptRowExpanded).toBe(true);
    expect(stability.maxBaselineDrift).toBeLessThanOrEqual(4);
    expect(stability.maxFrameDrift).toBeLessThanOrEqual(4);
    expect(stability.finalTopRange).toBeLessThanOrEqual(1);
  });

  test("does not reclassify already-painted DeepSeek text when a later tool call arrives", async () => {
    const { app, page } = harness;
    const threadId = await activateFixtureThread(harness, "Stable no-thinking fixture");
    const requestId = "stable-no-thinking-request";
    const prefix = [
      { id: "model", kind: "system", title: "Model", text: "mock/deepseek-v4-flash" },
      { id: "painted-text", kind: "assistant_text", text: "I will inspect the relevant source first." }
    ];

    await sendTimeline(app, { requestId, threadId, content: prefix[1].text, timeline: prefix });
    const live = page.locator(".assistant-block.live-message").last();
    const paintedOutput = live.locator(".timeline-output", { hasText: "inspect the relevant source" });
    await expect(paintedOutput).toBeVisible();
    await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_PAINTED_TIMELINE_ROW__?: Element;
        __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[];
        __JASMINE_TIMELINE_ROW_RENDERS__?: Record<string, number>;
      };
      scope.__JASMINE_PAINTED_TIMELINE_ROW__ = Array.from(document.querySelectorAll(".assistant-block.live-message .timeline-output"))
        .find((node) => node.textContent?.includes("inspect the relevant source"));
      scope.__JASMINE_MARKDOWN_RENDER_LENGTHS__ = [];
      scope.__JASMINE_TIMELINE_ROW_RENDERS__ = {};
    });

    const withTool = [
      ...prefix,
      {
        id: "later-tool-call",
        kind: "tool_call",
        toolName: "read",
        title: "Read source",
        argumentsJson: JSON.stringify({ path: "src/example.ts" })
      }
    ];
    await sendTimeline(app, { requestId, threadId, content: prefix[1].text, timeline: withTool });
    await expect(live.locator(".tool-run-item", { hasText: "src/example.ts" })).toBeVisible();
    await expect(live.locator(".tool-preamble-item")).toHaveCount(0);

    const continuity = await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_PAINTED_TIMELINE_ROW__?: Element;
        __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[];
        __JASMINE_TIMELINE_ROW_RENDERS__?: Record<string, number>;
      };
      const current = Array.from(document.querySelectorAll(".assistant-block.live-message .timeline-output"))
        .find((node) => node.textContent?.includes("inspect the relevant source"));
      return {
        sameRow: scope.__JASMINE_PAINTED_TIMELINE_ROW__ === current,
        markdownRenders: scope.__JASMINE_MARKDOWN_RENDER_LENGTHS__?.length ?? 0,
        paintedRowRenders: scope.__JASMINE_TIMELINE_ROW_RENDERS__?.["painted-text"] ?? 0
      };
    });
    expect(continuity).toEqual({ sameRow: true, markdownRenders: 0, paintedRowRenders: 0 });
  });

  test("shows every cumulative open-fence tick immediately without a debounced height jump", async () => {
    const { app, page } = harness;
    const threadId = await activateFixtureThread(harness, "Streaming code fence fixture");
    const requestId = "streaming-code-fence-request";
    const prefix = longMarkdown(8);
    const initialCode = streamingCode(100);
    const initialFence = `${prefix}\n## Active code\n\n\`\`\`ts\n${initialCode}`;
    await page.evaluate(() => {
      (window as Window & { __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[] }).__JASMINE_MARKDOWN_RENDER_LENGTHS__ = [];
    });

    await sendTimeline(app, {
      requestId,
      threadId,
      content: initialFence,
      timeline: [{ id: "open-code-output", kind: "assistant_text", text: initialFence }]
    });
    const live = page.locator(".assistant-block.live-message").last();
    const activeCodeBlock = live.locator(".code-block").last();
    await expect(activeCodeBlock).toHaveAttribute("data-highlighted-length", String(initialCode.length));

    const heights: number[] = [await activeCodeBlock.locator(".code-block-scroll").evaluate((node) => node.scrollHeight)];
    let openFence = initialFence;
    for (const lineCount of [200, 350, 500, 650]) {
      const code = streamingCode(lineCount);
      openFence = `${prefix}\n## Active code\n\n\`\`\`ts\n${code}`;
      await sendTimeline(app, {
        requestId,
        threadId,
        content: openFence,
        timeline: [{ id: "open-code-output", kind: "assistant_text", text: openFence }]
      });
      await page.waitForFunction((expectedLength) => {
        const blocks = document.querySelectorAll(".assistant-block.live-message .code-block");
        return blocks.item(blocks.length - 1).getAttribute("data-code-length") === String(expectedLength);
      }, code.length);

      // The code-length attribute changes in the same React commit as the
      // visible delta. Read synchronously here so the 140ms highlighter debounce
      // cannot hide the regression by eventually catching up.
      const tick = await activeCodeBlock.evaluate((node, expectedLine) => {
        const text = node.textContent ?? "";
        const scroll = node.querySelector(".code-block-scroll");
        return {
          hasLastLine: text.includes(expectedLine),
          lastLineOccurrences: text.split(expectedLine).length - 1,
          codeLength: Number(node.getAttribute("data-code-length")),
          highlightedLength: Number(node.getAttribute("data-highlighted-length")),
          scrollHeight: scroll?.scrollHeight ?? 0
        };
      }, `const streamedLine${lineCount} = ${lineCount};`);
      expect(tick.hasLastLine).toBe(true);
      expect(tick.lastLineOccurrences).toBe(1);
      expect(tick.codeLength).toBe(code.length);
      expect(tick.highlightedLength).toBeLessThan(code.length);
      expect(tick.scrollHeight).toBeGreaterThan(heights.at(-1) ?? 0);
      heights.push(tick.scrollHeight);
    }

    expect(openFence.length).toBeGreaterThan(15_000);
    const heightBeforeFinalHighlight = heights.at(-1) ?? 0;
    const finalCode = streamingCode(650);
    await expect(activeCodeBlock).toHaveAttribute("data-highlighted-length", String(finalCode.length));
    const heightAfterFinalHighlight = await activeCodeBlock.locator(".code-block-scroll").evaluate((node) => node.scrollHeight);
    expect(Math.abs(heightAfterFinalHighlight - heightBeforeFinalHighlight)).toBeLessThanOrEqual(1);

    const largestOpenFenceParse = await page.evaluate(() => Math.max(
      0,
      ...((window as Window & { __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[] }).__JASMINE_MARKDOWN_RENDER_LENGTHS__ ?? [])
    ));
    expect(largestOpenFenceParse).toBeLessThan(3_000);

    await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_OPEN_FENCE_FIGURE__?: Element;
        __JASMINE_OPEN_FENCE_SCROLL__?: Element;
        __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[];
      };
      const figures = document.querySelectorAll(".assistant-block.live-message .code-block");
      const figure = figures.item(figures.length - 1);
      scope.__JASMINE_OPEN_FENCE_FIGURE__ = figure;
      scope.__JASMINE_OPEN_FENCE_SCROLL__ = figure?.querySelector(".code-block-scroll") ?? undefined;
      scope.__JASMINE_MARKDOWN_RENDER_LENGTHS__ = [];
    });

    const closedFence = `${openFence}\n\`\`\`\n\nFence complete.`;
    await sendTimeline(app, {
      requestId,
      threadId,
      content: closedFence,
      timeline: [{ id: "open-code-output", kind: "assistant_text", text: closedFence }]
    });
    await expect(live.locator(".code-block").last()).toContainText("const streamedLine650 = 650;");
    await expect(live.locator(".timeline-output")).toContainText("Fence complete.");

    const closedFenceContinuity = await page.evaluate(({ expectedCodeLength, expectedHeight }) => {
      const scope = window as Window & {
        __JASMINE_OPEN_FENCE_FIGURE__?: Element;
        __JASMINE_OPEN_FENCE_SCROLL__?: Element;
        __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[];
      };
      const figures = document.querySelectorAll(".assistant-block.live-message .code-block");
      const figure = figures.item(figures.length - 1);
      const scroll = figure?.querySelector(".code-block-scroll");
      const lengths = scope.__JASMINE_MARKDOWN_RENDER_LENGTHS__ ?? [];
      return {
        sameFigure: scope.__JASMINE_OPEN_FENCE_FIGURE__ === figure,
        sameScroll: scope.__JASMINE_OPEN_FENCE_SCROLL__ === scroll,
        codeLength: Number(figure?.getAttribute("data-code-length")),
        heightDelta: Math.abs((scroll?.scrollHeight ?? 0) - expectedHeight),
        largestCloseParse: Math.max(0, ...lengths),
        expectedCodeLength
      };
    }, { expectedCodeLength: finalCode.length, expectedHeight: heightAfterFinalHighlight });
    expect(closedFenceContinuity).toEqual({
      sameFigure: true,
      sameScroll: true,
      codeLength: finalCode.length,
      heightDelta: 0,
      largestCloseParse: expect.any(Number),
      expectedCodeLength: finalCode.length
    });
    expect(closedFenceContinuity.largestCloseParse).toBeLessThan(3_000);

    const secondCode = Array.from({ length: 520 }, (_entry, index) => `const secondFenceLine${index + 1} = ${index + 1};`).join("\n");
    const secondOpenFence = `${closedFence}\n\nSecond fence:\n\n\`\`\`ts\n${secondCode}`;
    await sendTimeline(app, {
      requestId,
      threadId,
      content: secondOpenFence,
      timeline: [{ id: "open-code-output", kind: "assistant_text", text: secondOpenFence }]
    });
    const secondFigure = live.locator(".code-block").filter({ hasText: "secondFenceLine520" });
    await expect(secondFigure).toHaveAttribute("data-code-length", String(secondCode.length));
    await expect(secondFigure).toContainText("secondFenceLine520");
    await page.evaluate(() => {
      const blocks = Array.from(document.querySelectorAll(".assistant-block.live-message .code-block"));
      (window as Window & { __JASMINE_SECOND_FENCE_NODE__?: Element; __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[] }).__JASMINE_SECOND_FENCE_NODE__ = blocks.find((node) => node.textContent?.includes("secondFenceLine520"));
      (window as Window & { __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[] }).__JASMINE_MARKDOWN_RENDER_LENGTHS__ = [];
    });
    const secondExtendedCode = `${secondCode}\nconst secondFenceLine521 = 521;`;
    const secondExtendedFence = `${closedFence}\n\nSecond fence:\n\n\`\`\`ts\n${secondExtendedCode}`;
    await sendTimeline(app, {
      requestId,
      threadId,
      content: secondExtendedFence,
      timeline: [{ id: "open-code-output", kind: "assistant_text", text: secondExtendedFence }]
    });
    await expect(secondFigure).toHaveAttribute("data-code-length", String(secondExtendedCode.length));
    await expect(secondFigure).toContainText("secondFenceLine521");
    const secondContinuity = await page.evaluate(() => ({
      sameNode: (window as Window & { __JASMINE_SECOND_FENCE_NODE__?: Element }).__JASMINE_SECOND_FENCE_NODE__ === Array.from(document.querySelectorAll(".assistant-block.live-message .code-block")).find((node) => node.textContent?.includes("secondFenceLine521")),
      largestParse: Math.max(0, ...((window as Window & { __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[] }).__JASMINE_MARKDOWN_RENDER_LENGTHS__ ?? []))
    }));
    expect(secondContinuity.sameNode).toBe(true);
    expect(secondContinuity.largestParse).toBeLessThan(3_000);

    const nestedFence = "- nested item\n\n  ```ts\n  const nested = true;";
    await sendTimeline(app, {
      requestId,
      threadId,
      content: nestedFence,
      timeline: [{ id: "open-code-output", kind: "assistant_text", text: nestedFence }]
    });
    await expect(live.locator("li .code-block")).toContainText("const nested = true;");
  });
});

async function activateFixtureThread(harness: HarnessApp, title: string): Promise<string> {
  const thread = await harness.page.evaluate((threadTitle) => window.jasmine.createThread({ title: threadTitle }), title);
  await harness.page.reload();
  await harness.page.waitForSelector(".app-shell");
  await harness.page.getByRole("button", { name: title }).first().click();
  await expect(harness.page.locator(".empty-state")).toBeVisible();
  return thread.id;
}

async function sendTimeline(
  app: HarnessApp["app"],
  update: { requestId: string; threadId: string; content: string; timeline: Array<Record<string, unknown>> }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const mainWindow = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("index.html"));
    mainWindow?.webContents.send("chat:stream", {
      requestId: payload.requestId,
      threadId: payload.threadId,
      status: "running",
      liveMessages: [{
        role: "assistant",
        content: payload.content,
        timeline: payload.timeline
      }]
    });
  }, update);
}

async function sendSettlement(
  app: HarnessApp["app"],
  update: {
    requestId: string;
    threadId: string;
    persistedId: string;
    content: string;
    timeline: Array<Record<string, unknown>>;
  }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const mainWindow = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("index.html"));
    mainWindow?.webContents.send("chat:stream", {
      requestId: payload.requestId,
      threadId: payload.threadId,
      status: "done",
      settlement: {
        messages: [{
          id: payload.persistedId,
          renderId: `stream-${payload.requestId}-0`,
          threadId: payload.threadId,
          role: "assistant",
          content: payload.content,
          createdAt: new Date().toISOString(),
          elapsedMs: 1_234,
          modelId: "deepseek-v4-flash",
          timeline: payload.timeline
        }]
      }
    });
  }, update);
}

function longMarkdown(sectionCount: number): string {
  return Array.from({ length: sectionCount }, (_entry, index) => {
    const section = index + 1;
    return [
      `## Stable section ${section}`,
      "",
      `Paragraph ${section} has **bold text**, an [inline link](https://example.com/${section}), and enough prose to exercise cumulative Markdown parsing without changing any completed section that is already on screen.`,
      "",
      `- first list item for section ${section}`,
      `- second list item for section ${section}`,
      "",
      "```ts",
      `const section${section} = ${section};`,
      `console.log("stable markdown section ${section}", section${section});`,
      "```",
      ""
    ].join("\n");
  }).join("\n");
}

function streamingCode(lineCount: number): string {
  return Array.from({ length: lineCount }, (_entry, index) => `const streamedLine${index + 1} = ${index + 1};`).join("\n");
}

async function waitAnimationFrames(page: HarnessApp["page"], count: number): Promise<void> {
  await page.evaluate((frameCount) => new Promise<void>((resolve) => {
    let remaining = frameCount;
    const advance = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else window.requestAnimationFrame(advance);
    };
    window.requestAnimationFrame(advance);
  }), count);
}
