import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useThreadDraftPersistence } from "../../src/renderer/hooks/useThreadDraftPersistence";
import { installFakeBridge } from "./fakeBridge";

function DraftHarness(props: { threadId: string }) {
  const [draft, setDraft] = useState("");
  useThreadDraftPersistence({
    threadId: props.threadId,
    draft,
    editingMessage: null,
    setDraft
  });
  return <textarea aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
}

describe("thread draft persistence", () => {
  test("a delayed hydration cannot overwrite text entered after the request began", async () => {
    const bridge = installFakeBridge();
    let releaseHydration: ((value: string) => void) | null = null;
    bridge.setGetThreadDraftBehavior(() => new Promise((resolve) => {
      releaseHydration = resolve;
    }));
    const view = render(<DraftHarness threadId="alpha" />);

    const input = screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement;
    await waitFor(() => expect(bridge.calls.getThreadDraft).toEqual(["alpha"]));
    fireEvent.change(input, { target: { value: "typed before draft hydration settles" } });
    await act(async () => {
      releaseHydration?.("stale persisted draft");
    });
    expect(input.value).toBe("typed before draft hydration settles");

    bridge.setGetThreadDraftBehavior(async () => "fresh beta draft");
    view.rerender(<DraftHarness threadId="beta" />);
    await waitFor(() => expect(input.value).toBe("fresh beta draft"));
  });
});
