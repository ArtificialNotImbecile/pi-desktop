import { describe, expect, test } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { createChatStreamSettlement } from "../../src/shared/streamSettlement";
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

  test("an active A to B to A run keeps its settlement over the stale final page", async () => {
    const harness = await renderChatMessages();
    seedThread(harness, "alpha", ALPHA);
    seedThread(harness, "beta", BETA);
    await harness.selectThread(thread("alpha", { messageCount: 2 }));

    // Keep sendChatMessage unresolved after the stream settlement. That leaves
    // the hook's real request id associated with alpha while the final stale
    // alpha page lands, exercising settled.requestId === requestId rather than
    // the unrelated !requestId fallback.
    const prompt = "slow response slow timeline alpha settlement";
    const run = await harness.startRun(prompt);
    await run.stream("alpha is still working");

    const releaseBeta = harness.bridge.holdNextListMessages();
    await harness.selectThread(thread("beta", { messageCount: 2 }));
    const releaseFinalAlpha = harness.bridge.holdNextListMessages();
    await harness.selectThread(thread("alpha", { messageCount: 4 }));

    // The final alpha page was snapshotted before this assistant was persisted.
    // Its settlement is therefore the only source of the completed answer.
    const assistantMessage = harness.bridge.append("alpha", {
      id: `${run.requestId}-reply-1`,
      role: "assistant",
      content: "Slow response complete."
    });
    await harness.bridge.emit({
      requestId: run.requestId,
      threadId: "alpha",
      status: "done",
      settlement: createChatStreamSettlement(
        run.requestId,
        "alpha-a1",
        [run.userMessage],
        [assistantMessage],
        true
      )
    });
    expect(harness.renderedContent()).toContain("Slow response complete.");

    // Both superseded replies arrive only after the settlement. The final alpha
    // reply is current but stale and must be reconciled with this active run.
    await releaseBeta();
    await releaseFinalAlpha();

    expect(harness.renderedContent()).toContain(ALPHA);
    expect(harness.renderedContent()).toContain(prompt);
    expect(harness.renderedContent()).toContain("Slow response complete.");
    expect(harness.renderedContent()).not.toContain(BETA);
    const liveRows = harness.current().messages.filter((message) => message.id.startsWith("stream-"));
    expect(liveRows).toHaveLength(0);
    expect(harness.current().messages.find((message) => message.id === assistantMessage.id)).toMatchObject({
      renderId: `stream-${run.requestId}-0`
    });
    expect(harness.current().error).toBeNull();

    await run.complete(assistantMessage);
    expect(harness.current().runState).toBe("idle");
  });

  test("a stale page for a thread with no run does not resurrect a superseded answer", async () => {
    const harness = await renderChatMessages();
    harness.bridge.seed("alpha", [
      { id: "alpha-u1", role: "user", content: ALPHA },
      { id: "alpha-a1", role: "assistant", content: "superseded answer" }
    ]);
    harness.bridge.seed("beta", [{ id: "beta-u1", role: "user", content: BETA }]);
    await harness.selectThread(thread("alpha", { messageCount: 2 }));
    expect(harness.renderedContent()).toContain("superseded answer");

    // Read the old alpha page, switch away, then begin another alpha read and
    // hold its already-snapshotted reply. The settlement has no active request
    // association, so this explicitly covers the !requestId reconciliation.
    await harness.selectThread(thread("beta", { messageCount: 1 }));
    const releaseStaleAlpha = harness.bridge.holdNextListMessages();
    await harness.selectThread(thread("alpha", { messageCount: 2 }));

    await harness.bridge.emit({
      requestId: "run-2",
      threadId: "alpha",
      status: "done",
      settlement: createChatStreamSettlement("run-2", "alpha-u1", [], [
        { id: "alpha-a2", threadId: "alpha", role: "assistant", content: "regenerated answer", createdAt: "2026-01-01T00:00:20.000Z" }
      ])
    });

    expect(harness.renderedContent()).toContain("regenerated answer");
    expect(harness.renderedContent()).not.toContain("superseded answer");

    await releaseStaleAlpha();

    expect(harness.renderedContent()).toContain("regenerated answer");
    expect(harness.renderedContent()).not.toContain("superseded answer");
  });

  test("a provider failure keeps the rendered history and surfaces the error", async () => {
    const harness = await renderChatMessages();
    seedThread(harness, "alpha", ALPHA);
    await harness.selectThread(thread("alpha", { messageCount: 2 }));

    const prompt = "this send fails";
    harness.bridge.setSendBehavior(async (request) => {
      if (!request.requestId) throw new Error("Failed send reached the bridge without a requestId.");
      // chat:send persists the user row before provider generation can fail.
      harness.bridge.append(request.threadId, {
        id: `${request.requestId}-persisted-user`,
        role: "user",
        content: request.content
      });
      throw new Error("Provider is unreachable.");
    });
    await act(async () => {
      await harness.current().sendMessage(prompt);
    });

    expect(harness.renderedContent()).toContain(ALPHA);
    expect(harness.renderedContent()).toContain("Mock reply from Jasmine.");
    const failedUser = harness.current().messages.find((message) => message.content === prompt);
    const requestId = harness.bridge.calls.sendChatMessage.at(-1)?.requestId;
    expect(requestId).toBeTruthy();
    expect(failedUser).toMatchObject({
      id: `${requestId}-persisted-user`,
      renderId: `pending-${requestId}-0`,
      role: "user",
      content: prompt
    });
    expect(harness.current().error).toBeTruthy();
    expect(harness.current().runState).not.toBe("running");
  });

  test("a failed send on one thread does not write its state into another selection", async () => {
    const harness = await renderChatMessages();
    seedThread(harness, "alpha", ALPHA);
    seedThread(harness, "beta", BETA);
    await harness.selectThread(thread("alpha", { messageCount: 2 }));

    const prompt = "this late alpha send fails";
    harness.bridge.setSendBehavior(async (request) => {
      if (!request.requestId) throw new Error("Failed send reached the bridge without a requestId.");
      harness.bridge.append(request.threadId, {
        id: `${request.requestId}-persisted-user`,
        role: "user",
        content: request.content
      });
      throw new Error("Provider is unreachable.");
    });
    const readsBeforeFailure = harness.bridge.calls.listMessages.length;
    const releaseFailurePage = harness.bridge.holdNextListMessages();
    let failureCompletion: Promise<boolean> | null = null;
    await act(async () => {
      failureCompletion = harness.current().sendMessage(prompt);
      await Promise.resolve();
    });

    // Wait until failure reconciliation has actually read and held alpha's
    // persisted page. Switching before that point would only test the early
    // beginProviderFailureReconcile guard, not a late IPC reply.
    await waitFor(() => {
      expect(harness.bridge.calls.listMessages).toHaveLength(readsBeforeFailure + 1);
      expect(harness.bridge.calls.listMessages.at(-1)?.threadId).toBe("alpha");
    });

    await harness.selectThread(thread("beta", { messageCount: 2 }));
    expect(harness.renderedContent()).toContain(BETA);
    // Thread selection may commit the new route once before the hook's layout
    // effect clears the old rows. The retained E2E paint monitor owns that
    // transition. From this stable beta page onward, however, alpha's held IPC
    // reply must never commit under beta.
    const betaCommitOffset = harness.commits().length;

    await releaseFailurePage();
    await act(async () => {
      await failureCompletion;
    });

    expect(harness.renderedContent()).toContain(BETA);
    expect(harness.renderedContent()).not.toContain(ALPHA);
    expect(harness.renderedContent()).not.toContain(prompt);
    for (const commit of harness.commits().slice(betaCommitOffset).filter((entry) => entry.threadId === "beta")) {
      expect(commit.contents).not.toContain(ALPHA);
      expect(commit.contents).not.toContain(prompt);
    }
    // Errors are per thread, so beta must open clean.
    expect(harness.current().error).toBeNull();
  });
});
