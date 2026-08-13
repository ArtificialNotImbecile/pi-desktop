import { describe, expect, test } from "vitest";
import { act } from "@testing-library/react";
import { renderChatMessages, thread } from "./chatMessagesHarness";

const PAGE_SIZE = 160;

function seededMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index + 1}`,
    content: `large import message ${index + 1}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const)
  }));
}

/**
 * Paging behavior sunk from the @desktop-session case in tests/e2e/threads.spec.ts.
 * The jump-rail geometry that case also asserted stays in E2E: jsdom has no
 * layout, so mark alignment and viewport checks are not meaningful here.
 */
describe("chat message paging", () => {
  test("a large thread opens on its newest page and reports older history", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("t1", seededMessages(220));

    await harness.selectThread(thread("t1", { messageCount: 220 }));

    expect(harness.current().messages).toHaveLength(PAGE_SIZE);
    expect(harness.renderedContent()[0]).toBe("large import message 61");
    expect(harness.renderedContent().at(-1)).toBe("large import message 220");
    expect(harness.current().hasOlderMessages).toBe(true);
  });

  test("loading older messages prepends the remaining history exactly once", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("t1", seededMessages(220));
    await harness.selectThread(thread("t1", { messageCount: 220 }));

    await act(async () => {
      await harness.current().loadOlderMessages();
    });

    expect(harness.current().messages).toHaveLength(220);
    expect(harness.renderedContent()[0]).toBe("large import message 1");
    expect(harness.renderedContent().at(-1)).toBe("large import message 220");
    expect(harness.current().hasOlderMessages).toBe(false);
    expect(new Set(harness.renderedIds()).size).toBe(220);
  });

  test("the older-history request pages strictly before the oldest loaded row", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("t1", seededMessages(220));
    await harness.selectThread(thread("t1", { messageCount: 220 }));

    await act(async () => {
      await harness.current().loadOlderMessages();
    });

    const olderRequest = harness.bridge.calls.listMessages.at(-1);
    expect(olderRequest?.before?.id).toBe("m61");
    expect(olderRequest?.limit).toBe(PAGE_SIZE);
  });

  test("an older page that lands after a thread switch does not reach the new thread", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("t1", seededMessages(220));
    harness.bridge.seed("t2", [{ id: "other", role: "user" as const, content: "other thread message" }]);
    await harness.selectThread(thread("t1", { messageCount: 220 }));

    const release = harness.bridge.holdNextListMessages();
    let inFlight: Promise<void> | null = null;
    await act(async () => {
      inFlight = harness.current().loadOlderMessages();
    });
    await harness.selectThread(thread("t2", { messageCount: 1 }));
    expect(harness.renderedContent()).toEqual(["other thread message"]);

    await release();
    await act(async () => {
      await inFlight;
    });

    expect(harness.renderedContent()).toEqual(["other thread message"]);
  });

  test("a thread that fits in one page reports no older history", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("t1", seededMessages(12));

    await harness.selectThread(thread("t1", { messageCount: 12 }));

    expect(harness.current().messages).toHaveLength(12);
    expect(harness.current().hasOlderMessages).toBe(false);
  });

  test("older pages that arrive twice are merged by id, not duplicated", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("t1", seededMessages(220));
    await harness.selectThread(thread("t1", { messageCount: 220 }));

    await act(async () => {
      await Promise.all([
        harness.current().loadOlderMessages(),
        harness.current().loadOlderMessages()
      ]);
    });

    expect(harness.current().messages).toHaveLength(220);
    expect(new Set(harness.renderedIds()).size).toBe(220);
  });

  test("a click while an older page is in flight does not issue a second request", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("t1", seededMessages(220));
    await harness.selectThread(thread("t1", { messageCount: 220 }));
    const requestsAfterOpen = harness.bridge.calls.listMessages.length;

    // Hold the older-page reply so the in-flight state is actually committed
    // before the second click, which is the only way the guard engages: two
    // calls in one tick close over the same render and both see it as idle.
    const release = harness.bridge.holdNextListMessages();
    let inFlight: Promise<void> | null = null;
    await act(async () => {
      inFlight = harness.current().loadOlderMessages();
    });
    expect(harness.current().loadingOlderMessages).toBe(true);

    await act(async () => {
      await harness.current().loadOlderMessages();
    });
    expect(harness.bridge.calls.listMessages.length).toBe(requestsAfterOpen + 1);

    await release();
    await act(async () => {
      await inFlight;
    });
    expect(harness.current().messages).toHaveLength(220);
    expect(harness.current().loadingOlderMessages).toBe(false);
  });
});
