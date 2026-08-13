import { describe, expect, test } from "vitest";
import { renderChatMessages, thread } from "./chatMessagesHarness";

/**
 * Run lifecycle cases sunk from tests/e2e/chat-runtime.spec.ts. Each concerns
 * which rows useChatMessages holds when a run completes against a selection or
 * a page read that moved underneath it. The E2E versions drove a real provider
 * mock and staged the orderings with __JASMINE_MESSAGE_LOAD_DELAYS__; here the
 * run and the page read are both released explicitly.
 */
describe("chat message runs", () => {
  test("a run completing on one thread does not write into the selected thread", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("alpha", []);
    harness.bridge.seed("beta", []);
    await harness.selectThread(thread("alpha"));

    const slow = await harness.startRun("slow response first thread");
    await slow.stream("thinking on alpha");

    // The reader moves to a second chat and completes a fast run there while
    // alpha's run is still open.
    await harness.selectThread(thread("beta"));
    const fast = await harness.startRun("fast second thread");
    await fast.settle("Mock reply from Jasmine.");

    expect(harness.renderedContent()).toContain("fast second thread");
    expect(harness.current().messages.find((message) => message.content === "fast second thread")).toMatchObject({
      renderId: `pending-${fast.requestId}-0`
    });
    expect(harness.current().messages.find((message) => message.content === "Mock reply from Jasmine.")).toMatchObject({
      renderId: `stream-${fast.requestId}-0`
    });
    expect(harness.renderedContent()).not.toContain("slow response first thread");
    expect(harness.renderedContent()).not.toContain("thinking on alpha");

    // Alpha's run now finishes while beta is on screen. It must stay off screen.
    await slow.settle("Slow response complete.");
    expect(harness.renderedContent()).not.toContain("Slow response complete.");
    expect(harness.renderedContent()).toContain("fast second thread");

    // Returning to alpha shows alpha's own completed answer.
    await harness.selectThread(thread("alpha", { messageCount: 2 }));
    expect(harness.renderedContent()).toContain("slow response first thread");
    expect(harness.renderedContent()).toContain("Slow response complete.");
    expect(harness.renderedContent()).not.toContain("fast second thread");
  });

  test("a second run invalidates an initial page promoted to the first run", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("alpha", [
      { id: "h-user", role: "user", content: "rapid promotion history baseline" },
      { id: "h-reply", role: "assistant", content: "Mock reply from Jasmine." }
    ]);

    // The thread's opening page read is still in flight when two runs start on
    // it. That page predates both, so neither may inherit it.
    const releaseInitialPage = harness.bridge.holdNextListMessages();
    await harness.selectThread(thread("alpha", { messageCount: 2 }));

    const first = await harness.startRun("rapid promotion first run");
    await first.settle("Mock reply from Jasmine.", "h-reply");

    const second = await harness.startRun("rapid promotion second run");
    await second.stream("streaming the second run");
    expect(harness.renderedContent()).toContain("streaming the second run");

    await releaseInitialPage();

    // All three turns survive the late page: it erased neither newer run. The
    // two assistant rows are asserted before run two settles, because its final
    // settlement can restore only its own answer and mask either loss.
    expect(harness.current().messages).toHaveLength(6);
    expect(harness.renderedIds()).toContain(`${first.requestId}-reply-1`);
    expect(harness.current().messages).toContainEqual(expect.objectContaining({
      id: `stream-${second.requestId}-0`,
      role: "assistant",
      content: "streaming the second run"
    }));
    for (const text of [
      "rapid promotion history baseline",
      "rapid promotion first run",
      "rapid promotion second run"
    ]) {
      expect(harness.renderedContent()).toContain(text);
    }

    await second.settle("Slow response complete.", `${first.requestId}-reply-1`);
    expect(harness.renderedContent()).toContain("Slow response complete.");
    expect(harness.renderedContent()).toContain("rapid promotion history baseline");
    expect(harness.current().error).toBeNull();
  });

  test("a promoted delayed page keeps an older identical prompt without a third copy", async () => {
    const repeated = "same prompt promoted load identity";
    const harness = await renderChatMessages();
    harness.bridge.seed("alpha", [
      { id: "old-user", role: "user", content: repeated },
      { id: "old-reply", role: "assistant", content: "Mock reply from Jasmine." }
    ]);

    const releaseInitialPage = harness.bridge.holdNextListMessages();
    await harness.selectThread(thread("alpha", { messageCount: 2 }));

    // The same text is sent again while the opening page is still in flight, so
    // content alone cannot distinguish the old turn from the new optimistic one.
    const commitOffset = harness.commits().length;
    const run = await harness.startRun(repeated);
    await releaseInitialPage();
    expect(harness.renderedContent().filter((content) => content === repeated)).toHaveLength(2);
    await run.settle("Second reply.", "old-reply");

    const copies = harness.renderedContent().filter((content) => content === repeated);
    expect(copies).toHaveLength(2);
    expect(harness.renderedContent()).toContain("Mock reply from Jasmine.");
    expect(harness.renderedContent()).toContain("Second reply.");
    expect(new Set(harness.renderedIds()).size).toBe(harness.renderedIds().length);

    // A final-state assertion misses a third copy that is briefly committed and
    // then removed by settlement. The harness records only committed renders.
    const committedCopyCounts = harness.commits()
      .slice(commitOffset)
      .filter(({ threadId }) => threadId === "alpha")
      .map(({ contents }) => contents.filter((content) => content === repeated).length);
    expect(committedCopyCounts).toContain(2);
    expect(Math.max(...committedCopyCounts)).toBe(2);
  });
});
