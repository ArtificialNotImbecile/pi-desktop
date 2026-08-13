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
  /**
   * Starts a send and returns its live handle. The hook mints the requestId
   * internally with crypto.randomUUID, so it is read back off the send the fake
   * bridge received rather than guessed.
   */
  startRun(text: string): Promise<RunHandle>;
  unmount(): void;
};

export type RunHandle = {
  requestId: string;
  threadId: string;
  /** Emits a `running` event carrying the given live assistant text. */
  stream(text: string): Promise<void>;
  /**
   * Persists `text` as the run's assistant row, settles the run against
   * `replaceAfterMessageId`, and waits for the send to finish.
   */
  settle(text: string, replaceAfterMessageId?: string): Promise<void>;
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
    async startRun(text) {
      const sendsBefore = bridge.calls.sendChatMessage.length;
      let sending: Promise<boolean> | null = null;
      await act(async () => {
        sending = harness.current().sendMessage(text);
        // Let the optimistic row commit without awaiting the send: it does not
        // resolve until the run settles.
        await Promise.resolve();
      });
      const sent = bridge.calls.sendChatMessage.at(-1);
      if (!sent || bridge.calls.sendChatMessage.length === sendsBefore) {
        throw new Error(`sendMessage("${text}") never reached the bridge.`);
      }
      const { threadId } = sent;
      const requestId = sent.requestId;
      if (!requestId) throw new Error("Send reached the bridge without a requestId.");
      // Main persists the user row as part of handling the send, so the store
      // has to gain it here for a later page read to see the same history the
      // real database would return.
      const persistedUser = bridge.append(threadId, {
        id: `${requestId}-user`,
        role: "user",
        content: text
      });
      let replyIndex = 0;
      return {
        requestId,
        threadId,
        async stream(liveText) {
          await bridge.emit({
            requestId,
            threadId,
            status: "running",
            liveMessages: [{ role: "assistant", content: liveText }]
          });
        },
        async settle(replyText, replaceAfterMessageId) {
          replyIndex += 1;
          const id = `${requestId}-reply-${replyIndex}`;
          const persisted = bridge.append(threadId, { id, role: "assistant", content: replyText });
          await bridge.emit({
            requestId,
            threadId,
            status: "done",
            // The run's authoritative tail is the user turn plus its answer,
            // which is what the main process publishes.
            settlement: {
              ...(replaceAfterMessageId ? { replaceAfterMessageId } : {}),
              messages: [persistedUser, persisted]
            }
          });
          await act(async () => {
            await sending;
          });
        }
      };
    },
    unmount() {
      view?.unmount();
    }
  };
  return harness;
}
