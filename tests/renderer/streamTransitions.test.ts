import { describe, expect, test } from "vitest";
import { compactVisibleStreamTransition } from "../../src/renderer/hooks/useChatMessages";
import { applyStreamDelta } from "../../src/shared/streamDelta";

describe("visible stream transition compaction", () => {
  test("compacts queued cumulative snapshots into replayable stream deltas", () => {
    const first = [{
      role: "assistant" as const,
      content: "alpha",
      timeline: [{ id: "compact-output", kind: "assistant_text" as const, text: "alpha" }]
    }];
    const second = [{
      role: "assistant" as const,
      content: "alpha beta",
      timeline: [{ id: "compact-output", kind: "assistant_text" as const, text: "alpha beta" }]
    }];
    const third = [{
      role: "assistant" as const,
      content: "alpha beta gamma",
      timeline: [{ id: "compact-output", kind: "assistant_text" as const, text: "alpha beta gamma" }]
    }];

    const reset = compactVisibleStreamTransition(undefined, first);
    expect(reset?.kind).toBe("stream-reset");
    const deltaOne = compactVisibleStreamTransition(first, second);
    const deltaTwo = compactVisibleStreamTransition(second, third);
    expect(deltaOne?.kind).toBe("stream-delta");
    expect(deltaTwo?.kind).toBe("stream-delta");
    if (deltaOne?.kind !== "stream-delta" || deltaTwo?.kind !== "stream-delta") {
      throw new Error("Expected compact deltas.");
    }
    expect(deltaOne.delta.messages[0]?.contentAppend).toBe(" beta");
    expect(deltaOne.delta.messages[0]?.timelineDelta?.items[0]?.textAppend).toBe(" beta");
    expect(deltaTwo.delta.messages[0]?.contentAppend).toBe(" gamma");
    expect(applyStreamDelta(applyStreamDelta(first, deltaOne.delta), deltaTwo.delta)).toEqual(third);
    expect(compactVisibleStreamTransition(third, third)).toBeNull();
  });
});
