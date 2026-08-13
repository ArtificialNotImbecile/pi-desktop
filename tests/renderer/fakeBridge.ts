import { act } from "@testing-library/react";
import type {
  ChatEditRequest,
  ChatMessage,
  ChatQueueDeleteRequest,
  ChatQueueRequest,
  ChatQueueSteerRequest,
  ChatQueueUpdateRequest,
  ChatRetryRequest,
  ChatSendRequest,
  ChatStreamEvent,
  JasmineApi,
  MessageListRequest
} from "../../src/shared/ipc";

let nextRowId = 0;

/**
 * Drains the hook's requestAnimationFrame-paced visible-stream queue. The hook
 * deliberately spreads stream commits across frames so a slow renderer cannot
 * batch several into one layout jump, and each committed frame can schedule the
 * next from a layout effect, so several passes are needed to reach a resting
 * state.
 */
export async function flushFrames(count = 6): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
  }
}

type StoredMessage = ChatMessage & { __rowid: number };

export type FakeBridge = {
  bridge: JasmineApi;
  /** Replaces a thread's persisted history. Order is insertion order. */
  seed(threadId: string, messages: Array<Partial<ChatMessage> & { id: string }>): ChatMessage[];
  /** Appends one persisted row, as a completed run would. */
  append(threadId: string, message: Partial<ChatMessage> & { id: string }): ChatMessage;
  /**
   * Delivers a stream event to every `onChatStream` subscriber, then drains the
   * hook's requestAnimationFrame pacing so the resulting commit has landed by
   * the time this resolves.
   */
  emit(event: ChatStreamEvent): Promise<void>;
  /**
   * Withholds the next `listMessages` response until the returned function is
   * called. This is how a renderer test reproduces an out-of-order IPC reply --
   * deterministically, rather than by racing a timeout as the E2E harness has
   * to. `release()` resolves it and flushes React.
   */
  holdNextListMessages(): () => Promise<void>;
  calls: {
    listMessages: MessageListRequest[];
    sendChatMessage: ChatSendRequest[];
    retryChatMessage: ChatRetryRequest[];
    editChatMessage: ChatEditRequest[];
    cancelChatMessage: string[];
    queueChatMessage: ChatQueueRequest[];
  };
  /** Overrides the next `sendChatMessage` outcome (e.g. a provider failure). */
  setSendBehavior(behavior: (request: ChatSendRequest) => Promise<unknown>): void;
};

export function createFakeBridge(): FakeBridge {
  const threads = new Map<string, StoredMessage[]>();
  const streamListeners = new Set<(event: ChatStreamEvent) => void>();
  const heldListMessages: Array<{ resolve(value: ChatMessage[]): void; request: MessageListRequest }> = [];
  let holdCount = 0;
  let sendBehavior: ((request: ChatSendRequest) => Promise<unknown>) | null = null;

  const calls: FakeBridge["calls"] = {
    listMessages: [],
    sendChatMessage: [],
    retryChatMessage: [],
    editChatMessage: [],
    cancelChatMessage: [],
    queueChatMessage: []
  };

  function store(threadId: string): StoredMessage[] {
    const existing = threads.get(threadId);
    if (existing) return existing;
    const created: StoredMessage[] = [];
    threads.set(threadId, created);
    return created;
  }

  function materialize(threadId: string, message: Partial<ChatMessage> & { id: string }, index: number): StoredMessage {
    return {
      threadId,
      role: "user",
      content: message.id,
      // Distinct, ordered timestamps so `before` paging has a real cursor to
      // compare, matching the repository's (created_at, rowid) ordering.
      createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      ...message,
      __rowid: (nextRowId += 1)
    } as StoredMessage;
  }

  function strip(message: StoredMessage): ChatMessage {
    const { __rowid, ...rest } = message;
    void __rowid;
    return rest;
  }

  /**
   * Mirrors src/main/db/repositories/messages.ts: order by (createdAt, rowid),
   * take the newest `limit` at or before the cursor, return ascending.
   */
  function page(request: MessageListRequest): ChatMessage[] {
    const rows = [...store(request.threadId)].sort((a, b) =>
      a.createdAt === b.createdAt ? a.__rowid - b.__rowid : a.createdAt < b.createdAt ? -1 : 1
    );
    const limit = request.limit ? Math.max(1, Math.min(500, request.limit)) : undefined;
    if (!limit) return rows.map(strip);
    const cursor = request.before;
    const eligible = cursor
      ? rows.filter((row) => {
          if (row.createdAt < cursor.createdAt) return true;
          if (row.createdAt > cursor.createdAt) return false;
          const anchor = rows.find((candidate) => candidate.id === cursor.id);
          return anchor ? row.__rowid < anchor.__rowid : false;
        })
      : rows;
    return eligible.slice(-limit).map(strip);
  }

  const chatApi = {
    listMessages(request: string | MessageListRequest): Promise<ChatMessage[]> {
      const normalized: MessageListRequest = typeof request === "string" ? { threadId: request } : request;
      calls.listMessages.push(normalized);
      if (holdCount > 0) {
        holdCount -= 1;
        return new Promise<ChatMessage[]>((resolve) => {
          heldListMessages.push({ resolve, request: normalized });
        });
      }
      return Promise.resolve(page(normalized));
    },
    sendChatMessage(request: ChatSendRequest) {
      calls.sendChatMessage.push(request);
      if (sendBehavior) return sendBehavior(request);
      return Promise.resolve({ requestId: `req-${calls.sendChatMessage.length}`, threadId: request.threadId });
    },
    retryChatMessage(request: ChatRetryRequest) {
      calls.retryChatMessage.push(request);
      return Promise.resolve({ requestId: `retry-${calls.retryChatMessage.length}`, threadId: request.threadId });
    },
    editChatMessage(request: ChatEditRequest) {
      calls.editChatMessage.push(request);
      return Promise.resolve({ requestId: `edit-${calls.editChatMessage.length}`, threadId: request.threadId });
    },
    cancelChatMessage(requestId: string) {
      calls.cancelChatMessage.push(requestId);
      return Promise.resolve(true);
    },
    queueChatMessage(request: ChatQueueRequest) {
      calls.queueChatMessage.push(request);
      return Promise.resolve({ threadId: request.threadId, queue: { mode: "queue", messages: [] } });
    },
    updateQueuedChatMessage(request: ChatQueueUpdateRequest) {
      return Promise.resolve({ threadId: request.threadId, queue: { mode: "queue", messages: [] } });
    },
    deleteQueuedChatMessage(request: ChatQueueDeleteRequest) {
      return Promise.resolve({ threadId: request.threadId, queue: { mode: "queue", messages: [] } });
    },
    steerQueuedChatMessage(request: ChatQueueSteerRequest) {
      return Promise.resolve({ threadId: request.threadId, queue: { mode: "queue", messages: [] } });
    },
    onChatStream(callback: (event: ChatStreamEvent) => void) {
      streamListeners.add(callback);
      return () => streamListeners.delete(callback);
    }
  };

  // Anything the renderer reaches for that this fake does not model should fail
  // by name rather than silently resolve undefined and turn into a confusing
  // assertion failure three frames later.
  const bridge = new Proxy(chatApi, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      if (typeof property === "symbol") return undefined;
      return () => {
        throw new Error(
          `Fake desktop bridge has no "${String(property)}". Add it to tests/renderer/fakeBridge.ts if this test needs it.`
        );
      };
    }
  }) as unknown as JasmineApi;

  return {
    bridge,
    seed(threadId, messages) {
      const rows = messages.map((message, index) => materialize(threadId, message, index));
      threads.set(threadId, rows);
      return rows.map(strip);
    },
    append(threadId, message) {
      const rows = store(threadId);
      const row = materialize(threadId, message, rows.length);
      rows.push(row);
      return strip(row);
    },
    async emit(event) {
      await act(async () => {
        for (const listener of [...streamListeners]) listener(event);
      });
      await flushFrames();
    },
    holdNextListMessages() {
      holdCount += 1;
      return async () => {
        const held = heldListMessages.shift();
        if (!held) throw new Error("No held listMessages response to release.");
        // Paged at release time, so a test can mutate the store in between and
        // model an IPC reply that reflects state newer than its own request.
        await act(async () => {
          held.resolve(page(held.request));
        });
      };
    },
    calls,
    setSendBehavior(behavior) {
      sendBehavior = behavior;
    }
  };
}

/** Installs a fresh fake bridge on `window.jasmine` and returns its controls. */
export function installFakeBridge(): FakeBridge {
  const fake = createFakeBridge();
  (window as { jasmine?: JasmineApi }).jasmine = fake.bridge;
  return fake;
}
