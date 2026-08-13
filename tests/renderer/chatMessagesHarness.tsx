import { useState } from "react";
import { act, render } from "@testing-library/react";
import type { ChatThread } from "../../src/shared/ipc";
import { useChatMessages } from "../../src/renderer/hooks/useChatMessages";
import { installFakeBridge, type FakeBridge } from "./fakeBridge";

export type ChatHook = ReturnType<typeof useChatMessages>;

export type ChatHarness = {
  bridge: FakeBridge;
  /** The hook's current return value. Re-read it after every state change. */
  current(): ChatHook;
  /** Switches the active thread, as selecting a chat in the sidebar does. */
  selectThread(thread: ChatThread | null): Promise<void>;
  /** Message ids currently rendered, in order. */
  renderedIds(): string[];
  /** Message contents currently rendered, in order. */
  renderedContent(): string[];
  /**
   * Every committed render, as {threadId, contents}. Useful for asserting that
   * a late reply never reached the screen at all, rather than only checking
   * where things settled.
   *
   * This is not a substitute for the rAF paint monitor in
   * tests/e2e/chat-runtime.spec.ts. App passes chat.messages through unfiltered,
   * so a commit carrying the old thread's rows before the new page arrives is
   * expected; whether any painted frame shows it is a timing property only the
   * real renderer can answer.
   */
  commits(): Array<{ threadId: string | null; contents: string[] }>;
  refreshThreads: { calls: Array<string | null | undefined> };
  patchThread: { calls: Array<{ threadId: string; partial: Partial<ChatThread> }> };
  unmount(): void;
};

export function thread(id: string, overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    title: id,
    projectId: null,
    messageCount: 0,
    activePluginIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

/**
 * Mounts useChatMessages on its own against a fake desktop bridge. The hook
 * imports only React, shared types, two pure stream modules, getBridge, and
 * errorMessage -- no Electron and no DOM-heavy libraries -- so its reconciliation
 * behavior is fully reachable here.
 */
export async function renderChatMessages(initialThread: ChatThread | null = null): Promise<ChatHarness> {
  const bridge = installFakeBridge();
  const refreshThreads: ChatHarness["refreshThreads"] = { calls: [] };
  const patchThread: ChatHarness["patchThread"] = { calls: [] };

  let hook: ChatHook | null = null;
  let setThread: ((next: ChatThread | null) => void) | null = null;
  const commits: Array<{ threadId: string | null; contents: string[] }> = [];

  function Probe(props: { initial: ChatThread | null }) {
    const [activeThread, setActiveThread] = useState(props.initial);
    setThread = setActiveThread;
    hook = useChatMessages({
      activeThread,
      async refreshThreads(threadId) {
        refreshThreads.calls.push(threadId);
      },
      patchThread(threadId, partial) {
        patchThread.calls.push({ threadId, partial });
      }
    });
    commits.push({
      threadId: activeThread?.id ?? null,
      contents: hook.messages.map((message) => message.content)
    });
    // The scroll container the hook drives. jsdom reports zero for every
    // measurement, which is fine: these tests assert message state, and scroll
    // position assertions stay in E2E where layout is real.
    return <div className="message-scroll" ref={hook.messageScrollRef} />;
  }

  let view: ReturnType<typeof render> | null = null;
  await act(async () => {
    view = render(<Probe initial={initialThread} />);
  });

  const harness: ChatHarness = {
    bridge,
    current() {
      if (!hook) throw new Error("useChatMessages is not mounted.");
      return hook;
    },
    async selectThread(next) {
      await act(async () => {
        setThread?.(next);
      });
    },
    renderedIds() {
      return harness.current().messages.map((message) => message.id);
    },
    renderedContent() {
      return harness.current().messages.map((message) => message.content);
    },
    commits() {
      return commits;
    },
    refreshThreads,
    patchThread,
    unmount() {
      view?.unmount();
    }
  };
  return harness;
}
