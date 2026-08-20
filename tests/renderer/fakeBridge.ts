import { act } from "@testing-library/react";
import type {
  AppUpdateState,
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
  LocalFileDescription,
  MessageListRequest,
  ThreadDraftUpdateRequest
} from "../../src/shared/ipc";

let nextRowId = 0;

/**
 * Drains the hook's requestAnimationFrame-paced visible stream. Provider events
 * that arrive before a paint are coalesced to the newest cumulative snapshot;
 * several passes still cover a React commit followed by its layout effect.
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

type ModeledBridgeApi = Pick<
  JasmineApi,
  | "platform"
  | "listMessages"
  | "sendChatMessage"
  | "retryChatMessage"
  | "editChatMessage"
  | "cancelChatMessage"
  | "queueChatMessage"
  | "updateQueuedChatMessage"
  | "deleteQueuedChatMessage"
  | "steerQueuedChatMessage"
  | "updateChatContextTaxonomyCapture"
  | "onChatStream"
  | "getAppUpdateState"
  | "checkForAppUpdate"
  | "downloadAppUpdate"
  | "installAppUpdate"
  | "openAppUpdateDownloadPage"
  | "onAppUpdateStateChanged"
  | "listExecutableDiscovery"
  | "getThreadDraft"
  | "updateThreadDraft"
  | "describeLocalFiles"
  | "openLocalPath"
  | "revealLocalPath"
  | "openExternalUrl"
>;

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
  /** Delivers several provider events in one task without advancing paint. */
  emitBurst(events: ChatStreamEvent[]): Promise<void>;
  /**
   * Withholds the next `listMessages` response until the returned function is
   * called. This is how a renderer test reproduces an out-of-order IPC reply --
   * deterministically, rather than by racing a timeout as the E2E harness has
   * to.
   *
   * The rows are paged when the request arrives and delivered unchanged on
   * release, matching the real handler, which reads SQLite before its response
   * travels. A reply released after later writes therefore carries a genuinely
   * stale page.
   */
  holdNextListMessages(): () => Promise<void>;
  calls: {
    listMessages: MessageListRequest[];
    sendChatMessage: ChatSendRequest[];
    retryChatMessage: ChatRetryRequest[];
    editChatMessage: ChatEditRequest[];
    cancelChatMessage: string[];
    queueChatMessage: ChatQueueRequest[];
    updateQueuedChatMessage: ChatQueueUpdateRequest[];
    deleteQueuedChatMessage: ChatQueueDeleteRequest[];
    steerQueuedChatMessage: ChatQueueSteerRequest[];
    getThreadDraft: string[];
    updateThreadDraft: ThreadDraftUpdateRequest[];
    describeLocalFiles: string[][];
    openLocalPath: string[];
    revealLocalPath: string[];
    openExternalUrl: string[];
  };
  /**
   * Declares what the main process would report for paths an assistant answer
   * references. Unlisted paths describe as missing, which is what the renderer
   * sees when a model names a file that is not there.
   */
  setLocalFiles(files: Array<Partial<LocalFileDescription> & { path: string }>): void;
  /** Overrides the next `sendChatMessage` outcome (e.g. a provider failure). */
  setSendBehavior(behavior: JasmineApi["sendChatMessage"]): void;
  /** Replaces draft reads so a test can hold hydration deterministically. */
  setGetThreadDraftBehavior(behavior: JasmineApi["getThreadDraft"]): void;
};

export function createFakeBridge(): FakeBridge {
  const threads = new Map<string, StoredMessage[]>();
  const streamListeners = new Set<(event: ChatStreamEvent) => void>();
  const appUpdateListeners = new Set<(state: AppUpdateState) => void>();
  const heldListMessages: Array<{ resolve(value: ChatMessage[]): void; snapshot: ChatMessage[] }> = [];
  let holdCount = 0;
  let sendBehavior: JasmineApi["sendChatMessage"] | null = null;
  let getThreadDraftBehavior: JasmineApi["getThreadDraft"] = async () => "";
  const appUpdateState: AppUpdateState = {
    phase: "idle",
    supported: true,
    installMode: "automatic",
    currentVersion: "0.3.4",
    availableVersion: null,
    progressPercent: null,
    bytesPerSecond: null,
    transferredBytes: null,
    totalBytes: null,
    lastCheckedAt: null,
    error: null
  };

  const calls: FakeBridge["calls"] = {
    listMessages: [],
    sendChatMessage: [],
    retryChatMessage: [],
    editChatMessage: [],
    cancelChatMessage: [],
    queueChatMessage: [],
    updateQueuedChatMessage: [],
    deleteQueuedChatMessage: [],
    steerQueuedChatMessage: [],
    getThreadDraft: [],
    updateThreadDraft: [],
    describeLocalFiles: [],
    openLocalPath: [],
    revealLocalPath: [],
    openExternalUrl: []
  };

  const localFiles = new Map<string, LocalFileDescription>();

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

  function responseMessage(
    threadId: string,
    id: string,
    role: ChatMessage["role"],
    content: string
  ): ChatMessage {
    return {
      id,
      threadId,
      role,
      content,
      createdAt: new Date(1_800_000_000_000 + nextRowId * 1_000).toISOString(),
      status: "sent"
    };
  }

  function emptyQueue() {
    return { followUp: [], steering: [] };
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
    platform: "win32" as NodeJS.Platform,
    listMessages(request: string | MessageListRequest): Promise<ChatMessage[]> {
      const normalized: MessageListRequest = typeof request === "string" ? { threadId: request } : request;
      calls.listMessages.push(normalized);
      if (holdCount > 0) {
        holdCount -= 1;
        // Paged now, delivered later. The real messages:list handler reads
        // SQLite and only then does the response travel, so a held reply must
        // carry the rows as they were when the request was made -- not as they
        // are when it finally lands. That difference is the whole point of
        // these tests: the page is stale, and the renderer has to notice.
        const snapshot = page(normalized);
        return new Promise<ChatMessage[]>((resolve) => {
          heldListMessages.push({ resolve, snapshot });
        });
      }
      return Promise.resolve(page(normalized));
    },
    sendChatMessage(request: ChatSendRequest) {
      calls.sendChatMessage.push(request);
      if (sendBehavior) {
        const behavior = sendBehavior;
        sendBehavior = null;
        return behavior(request);
      }
      const requestId = request.requestId ?? `send-${calls.sendChatMessage.length}`;
      const userMessage = responseMessage(request.threadId, `${requestId}-response-user`, "user", request.content);
      const assistantMessage = responseMessage(
        request.threadId,
        `${requestId}-response-assistant`,
        "assistant",
        "Fake assistant response."
      );
      return Promise.resolve({
        userMessage,
        assistantMessage,
        content: assistantMessage.content,
        model: "fake-model",
        elapsedMs: 0
      });
    },
    retryChatMessage(request: ChatRetryRequest) {
      calls.retryChatMessage.push(request);
      const requestId = request.requestId ?? `retry-${calls.retryChatMessage.length}`;
      const assistantMessage = responseMessage(
        request.threadId,
        `${requestId}-response-assistant`,
        "assistant",
        "Fake retry response."
      );
      return Promise.resolve({
        assistantMessage,
        content: assistantMessage.content,
        model: "fake-model",
        elapsedMs: 0
      });
    },
    editChatMessage(request: ChatEditRequest) {
      calls.editChatMessage.push(request);
      const requestId = request.requestId ?? `edit-${calls.editChatMessage.length}`;
      const userMessage = responseMessage(request.threadId, `${requestId}-response-user`, "user", request.content);
      const assistantMessage = responseMessage(
        request.threadId,
        `${requestId}-response-assistant`,
        "assistant",
        "Fake edit response."
      );
      return Promise.resolve({
        userMessage,
        assistantMessage,
        content: assistantMessage.content,
        model: "fake-model",
        elapsedMs: 0
      });
    },
    cancelChatMessage(requestId: string) {
      calls.cancelChatMessage.push(requestId);
      return Promise.resolve(true);
    },
    queueChatMessage(request: ChatQueueRequest) {
      calls.queueChatMessage.push(request);
      return Promise.resolve({ queue: emptyQueue() });
    },
    updateQueuedChatMessage(request: ChatQueueUpdateRequest) {
      calls.updateQueuedChatMessage.push(request);
      return Promise.resolve({ queue: emptyQueue() });
    },
    deleteQueuedChatMessage(request: ChatQueueDeleteRequest) {
      calls.deleteQueuedChatMessage.push(request);
      return Promise.resolve({ queue: emptyQueue() });
    },
    steerQueuedChatMessage(request: ChatQueueSteerRequest) {
      calls.steerQueuedChatMessage.push(request);
      return Promise.resolve({ queue: emptyQueue() });
    },
    updateChatContextTaxonomyCapture() {
      return Promise.resolve(false);
    },
    onChatStream(callback: (event: ChatStreamEvent) => void) {
      streamListeners.add(callback);
      return () => streamListeners.delete(callback);
    },
    getAppUpdateState() {
      return Promise.resolve(appUpdateState);
    },
    checkForAppUpdate() {
      return Promise.resolve(appUpdateState);
    },
    downloadAppUpdate() {
      return Promise.resolve(appUpdateState);
    },
    installAppUpdate() {
      return Promise.resolve(appUpdateState);
    },
    openAppUpdateDownloadPage() {
      return Promise.resolve(appUpdateState);
    },
    onAppUpdateStateChanged(callback: (state: AppUpdateState) => void) {
      appUpdateListeners.add(callback);
      return () => appUpdateListeners.delete(callback);
    },
    listExecutableDiscovery(kind) {
      return Promise.resolve({ kind, candidates: [] });
    },
    getThreadDraft(threadId) {
      calls.getThreadDraft.push(threadId);
      return getThreadDraftBehavior(threadId);
    },
    updateThreadDraft(request) {
      calls.updateThreadDraft.push(request);
      return Promise.resolve();
    },
    describeLocalFiles(paths) {
      calls.describeLocalFiles.push(paths);
      return Promise.resolve(paths.map((requestedPath) => localFiles.get(requestedPath) ?? {
        requestedPath,
        path: requestedPath,
        name: requestedPath.split(/[\\/]/).pop() ?? requestedPath,
        exists: false,
        kind: "missing" as const
      }));
    },
    openLocalPath(filePath) {
      calls.openLocalPath.push(filePath);
      return Promise.resolve();
    },
    revealLocalPath(filePath) {
      calls.revealLocalPath.push(filePath);
      return Promise.resolve();
    },
    openExternalUrl(url) {
      calls.openExternalUrl.push(url);
      return Promise.resolve();
    }
  } satisfies ModeledBridgeApi;

  // Anything the renderer reaches for that this fake does not model should fail
  // on access by name rather than silently resolve undefined (or a truthy
  // placeholder for a data property) and turn into a false positive.
  const bridge = new Proxy(chatApi, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      if (typeof property === "symbol") return undefined;
      throw new Error(
        `Fake desktop bridge has no "${String(property)}". Add it to tests/renderer/fakeBridge.ts if this test needs it.`
      );
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
    async emitBurst(events) {
      await act(async () => {
        for (const event of events) {
          for (const listener of [...streamListeners]) listener(event);
        }
      });
    },
    holdNextListMessages() {
      holdCount += 1;
      return async () => {
        const held = heldListMessages.shift();
        if (!held) throw new Error("No held listMessages response to release.");
        await act(async () => {
          held.resolve(held.snapshot);
        });
        await flushFrames();
      };
    },
    calls,
    setSendBehavior(behavior) {
      sendBehavior = behavior;
    },
    setGetThreadDraftBehavior(behavior) {
      getThreadDraftBehavior = behavior;
    },
    setLocalFiles(files) {
      for (const file of files) {
        localFiles.set(file.path, {
          requestedPath: file.path,
          name: file.path.split(/[\\/]/).pop() ?? file.path,
          exists: true,
          kind: "file",
          ...file
        });
      }
    }
  };
}

/** Installs a fresh fake bridge on `window.jasmine` and returns its controls. */
export function installFakeBridge(): FakeBridge {
  const fake = createFakeBridge();
  (window as { jasmine?: JasmineApi }).jasmine = fake.bridge;
  return fake;
}
