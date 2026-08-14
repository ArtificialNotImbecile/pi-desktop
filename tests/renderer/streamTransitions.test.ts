import { describe, expect, test } from "vitest";
import { renderChatMessages, thread } from "./chatMessagesHarness";
import { flushFrames } from "./fakeBridge";

describe("visible stream frame publication", () => {
  test("paints the newest cumulative snapshot instead of replaying a burst over later frames", async () => {
    const harness = await renderChatMessages();
    await harness.selectThread(thread("frame-coalescing"));
    const run = await harness.startRun("show the latest frame");
    const frame = (text: string) => ({
      requestId: run.requestId,
      threadId: run.threadId,
      status: "running" as const,
      liveMessages: [{
        role: "assistant" as const,
        content: text,
        timeline: [{ id: "coalesced-output", kind: "assistant_text" as const, text }]
      }]
    });

    await harness.bridge.emitBurst([
      frame("alpha"),
      frame("alpha beta"),
      frame("alpha beta gamma")
    ]);
    await flushFrames(1);

    expect(harness.renderedContent()).toContain("alpha beta gamma");
    expect(harness.commits().filter(({ contents }) => (
      contents.includes("alpha") || contents.includes("alpha beta")
    ))).toHaveLength(0);

    await run.settle("alpha beta gamma");
    harness.unmount();
  });
});
