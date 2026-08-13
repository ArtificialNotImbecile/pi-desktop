import { describe, expect, test } from "vitest";
import { act } from "@testing-library/react";
import { renderChatMessages, thread } from "./chatMessagesHarness";

/**
 * Message reconciliation sunk from tests/e2e/chat-runtime.spec.ts. These cases
 * are about which rows the hook holds after loads, streams, and settlements
 * interleave -- no layout, no Electron. The E2E versions had to provoke the
 * orderings with wall-clock delays (`__JASMINE_MESSAGE_LOAD_DELAYS__`, 5s each);
 * here the in-flight replies are held and released explicitly, so the ordering
 * under test is the ordering that runs.
 */

const ALPHA = "alpha epoch baseline";
const BETA = "beta epoch baseline";

function seedThread(harness: Awaited<ReturnType<typeof renderChatMessages>>, id: string, prompt: string) {
  harness.bridge.seed(id, [
    { id: `${id}-u1`, role: "user", content: prompt },
    { id: `${id}-a1`, role: "assistant", content: "Mock reply from Jasmine." }
  ]);
}

describe("chat message reconciliation", () => {
  test("switching threads replaces the previous thread's rows with one page read", async () => {
    const harness = await renderChatMessages();
    seedThread(harness, "alpha", ALPHA);
    seedThread(harness, "beta", BETA);

    await harness.selectThread(thread("alpha", { messageCount: 2 }));
    expect(harness.renderedContent()).toContain(ALPHA);
    const readsAfterAlpha = harness.bridge.calls.listMessages.length;

    await harness.selectThread(thread("beta", { messageCount: 2 }));

    expect(harness.renderedContent()).toContain(BETA);
    expect(harness.renderedContent()).not.toContain(ALPHA);
    expect(harness.bridge.calls.listMessages.length).toBe(readsAfterAlpha + 1);
    expect(harness.bridge.calls.listMessages.at(-1)?.threadId).toBe("beta");
    // Whether any *painted frame* shows alpha's rows under beta's selection is a
    // timing property of the real renderer -- App passes chat.messages through
    // unfiltered, so a transient commit before beta's page arrives is expected.
    // The rAF frame monitor in tests/e2e/chat-runtime.spec.ts still owns that.
  });

  test("a stale load for a de-selected thread cannot overwrite the new selection", async () => {
    const harness = await renderChatMessages();
    seedThread(harness, "alpha", ALPHA);
    seedThread(harness, "beta", BETA);

    // Alpha's page is still in flight when the reader moves to beta.
    const releaseAlpha = harness.bridge.holdNextListMessages();
    await harness.selectThread(thread("alpha", { messageCount: 2 }));
    await harness.selectThread(thread("beta", { messageCount: 2 }));
    expect(harness.renderedContent()).toContain(BETA);

    await releaseAlpha();

    expect(harness.renderedContent()).toContain(BETA);
    expect(harness.renderedContent()).not.toContain(ALPHA);
    for (const commit of harness.commits().filter((entry) => entry.threadId === "beta")) {
      expect(commit.contents).not.toContain(ALPHA);
    }
  });

  test("A to B to A leaves the last selection's own history rendered", async () => {
    const harness = await renderChatMessages();
    seedThread(harness, "alpha", ALPHA);
    seedThread(harness, "beta", BETA);

    const releaseFirstAlpha = harness.bridge.holdNextListMessages();
    await harness.selectThread(thread("alpha", { messageCount: 2 }));
    const releaseBeta = harness.bridge.holdNextListMessages();
    await harness.selectThread(thread("beta", { messageCount: 2 }));
    await harness.selectThread(thread("alpha", { messageCount: 2 }));

    // The two superseded replies land after the current selection's own load.
    await releaseFirstAlpha();
    await releaseBeta();

    expect(harness.renderedContent()).toContain(ALPHA);
    expect(harness.renderedContent()).not.toContain(BETA);
  });

  test("a settled run survives a list response that raced it", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("alpha", [{ id: "alpha-u1", role: "user", content: ALPHA }]);

    // The opening page read is still in flight when a run settles on the same
    // thread. That page was read before the run finished, so applying it as-is
    // would drop the settled answer.
    const releaseStale = harness.bridge.holdNextListMessages();
    await harness.selectThread(thread("alpha", { messageCount: 1 }));

    // Deliberately not appended to the store: the held page must stay as it was
    // read, so the settlement is the only thing that can put the answer on
    // screen and the assertion cannot pass by way of the page alone.
    await harness.bridge.emit({
      requestId: "run-1",
      threadId: "alpha",
      status: "done",
      settlement: {
        replaceAfterMessageId: "alpha-u1",
        messages: [
          { id: "alpha-a1", threadId: "alpha", role: "assistant", content: "Slow response complete.", createdAt: "2026-01-01T00:00:10.000Z" }
        ]
      }
    });
    expect(harness.renderedContent()).toContain("Slow response complete.");

    await releaseStale();

    expect(harness.renderedContent()).toContain(ALPHA);
    expect(harness.renderedContent()).toContain("Slow response complete.");
    // The settled run leaves no live row behind and reports no error, which is
    // what the E2E case checked as `.assistant-block.live-message` count 0 and
    // a hidden `.error-strip`.
    const liveRows = harness.current().messages.filter((message) => (
      message.id.startsWith("stream-") || message.renderId?.startsWith("stream-")
    ));
    expect(liveRows).toHaveLength(0);
    expect(harness.current().error).toBeNull();
  });

  test("a stale page for a thread with no run does not resurrect a superseded answer", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("alpha", [
      { id: "alpha-u1", role: "user", content: ALPHA },
      { id: "alpha-a1", role: "assistant", content: "superseded answer" }
    ]);
    await harness.selectThread(thread("alpha", { messageCount: 2 }));
    expect(harness.renderedContent()).toContain("superseded answer");

    // A regenerate truncates the old answer and settles a new one.
    await harness.bridge.emit({
      requestId: "run-2",
      threadId: "alpha",
      status: "done",
      settlement: {
        replaceAfterMessageId: "alpha-u1",
        messages: [
          { id: "alpha-a2", threadId: "alpha", role: "assistant", content: "regenerated answer", createdAt: "2026-01-01T00:00:20.000Z" }
        ]
      }
    });

    expect(harness.renderedContent()).toContain("regenerated answer");
    expect(harness.renderedContent()).not.toContain("superseded answer");
  });

  test("a provider failure keeps the rendered history and surfaces the error", async () => {
    const harness = await renderChatMessages();
    seedThread(harness, "alpha", ALPHA);
    await harness.selectThread(thread("alpha", { messageCount: 2 }));

    harness.bridge.setSendBehavior(async () => {
      throw new Error("Provider is unreachable.");
    });
    await act(async () => {
      await harness.current().sendMessage("this send fails");
    });

    expect(harness.renderedContent()).toContain(ALPHA);
    expect(harness.renderedContent()).toContain("Mock reply from Jasmine.");
    expect(harness.current().error).toBeTruthy();
    expect(harness.current().runState).not.toBe("running");
  });

  test("a failed send on one thread does not write its state into another selection", async () => {
    const harness = await renderChatMessages();
    seedThread(harness, "alpha", ALPHA);
    seedThread(harness, "beta", BETA);
    await harness.selectThread(thread("alpha", { messageCount: 2 }));

    harness.bridge.setSendBehavior(async () => {
      throw new Error("Provider is unreachable.");
    });
    await act(async () => {
      await harness.current().sendMessage("this send fails");
    });
    expect(harness.current().error).toBeTruthy();

    await harness.selectThread(thread("beta", { messageCount: 2 }));

    expect(harness.renderedContent()).toContain(BETA);
    expect(harness.renderedContent()).not.toContain(ALPHA);
    // Errors are per thread, so beta must open clean.
    expect(harness.current().error).toBeNull();
  });
});
