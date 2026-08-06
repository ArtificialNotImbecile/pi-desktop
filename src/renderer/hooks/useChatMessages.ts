import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatQueueMode, ChatQueueState, ChatStreamEvent, ChatStreamMessage, ChatThread, ChatTimelineItem, PickedPath, ReasoningEffort } from "../../shared/ipc";
import { applyStreamDelta } from "../../shared/streamDelta";
import type { RunState } from "../types";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

const MESSAGE_PAGE_SIZE = 160;

export function useChatMessages(options: {
  activeThread: ChatThread | null;
  refreshThreads(threadId?: string | null): Promise<void>;
  patchThread(threadId: string, partial: Partial<ChatThread>): void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [threadRunStates, setThreadRunStates] = useState<Record<string, RunState>>({});
  const [threadRunModels, setThreadRunModels] = useState<Record<string, string>>({});
  const [threadErrors, setThreadErrors] = useState<Record<string, string | null>>({});
  const [threadRequestIds, setThreadRequestIds] = useState<Record<string, string>>({});
  const [threadQueues, setThreadQueues] = useState<Record<string, ChatQueueState>>({});
  const activeThreadIdRef = useRef<string | null>(null);
  const refreshThreadsRef = useRef(options.refreshThreads);
  const patchThreadRef = useRef(options.patchThread);
  const threadRequestIdsRef = useRef<Record<string, string>>({});
  const threadRunModelsRef = useRef<Record<string, string>>({});
  const messagesRef = useRef<ChatMessage[]>([]);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const autoFollowLockedThreadIdsRef = useRef<Set<string>>(new Set());
  const lockedScrollTopRef = useRef<Record<string, number>>({});
  const scrollFrameRef = useRef<number | null>(null);
  const pendingScrollActionRef = useRef<(() => void) | null>(null);
  // Last reconstructed live-message array per requestId, used as the base when the
  // main process streams incremental deltas instead of full snapshots.
  const liveStreamSnapshotsRef = useRef<Map<string, ChatStreamMessage[]>>(new Map());

  const activeThreadId = options.activeThread?.id ?? null;
  const runState = activeThreadId ? threadRunStates[activeThreadId] ?? "idle" : "idle";
  const runModelLabel = activeThreadId ? threadRunModels[activeThreadId] ?? null : null;
  const error = activeThreadId ? threadErrors[activeThreadId] ?? null : null;
  // The shared EMPTY_QUEUE_STATE constant keeps this reference stable across
  // renders so memoized consumers (Composer) are not invalidated per stream tick.
  const queueState = activeThreadId ? threadQueues[activeThreadId] ?? EMPTY_QUEUE_STATE : EMPTY_QUEUE_STATE;
  const hasOlderMessages = Boolean(options.activeThread && messages.length > 0 && messages.length < options.activeThread.messageCount);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
    if (activeThreadId) {
      void loadMessages(activeThreadId);
    } else {
      setMessages([]);
    }
  }, [activeThreadId]);

  useEffect(() => {
    return getBridge().onChatStream((event) => {
      // Title generation lands mid-stream; patch the one thread locally instead
      // of re-listing every thread (which used to cost a full listThreads IPC).
      if (event.threadTitle) patchThreadRef.current(event.threadId, { title: event.threadTitle });
      if (event.queue) setThreadQueue(event.threadId, event.queue);
      if (event.status === "running" && (event.liveMessages !== undefined || event.delta !== undefined || event.content !== undefined || event.timeline !== undefined)) applyStreamEvent(event);
    });
  }, []);

  useEffect(() => {
    refreshThreadsRef.current = options.refreshThreads;
  }, [options.refreshThreads]);

  useEffect(() => {
    patchThreadRef.current = options.patchThread;
  }, [options.patchThread]);

  useEffect(() => {
    threadRequestIdsRef.current = threadRequestIds;
  }, [threadRequestIds]);

  useEffect(() => {
    threadRunModelsRef.current = threadRunModels;
  }, [threadRunModels]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    };
  }, []);

  async function loadMessages(threadId: string) {
    try {
      const nextMessages = await getBridge().listMessages({ threadId, limit: MESSAGE_PAGE_SIZE });
      if (activeThreadIdRef.current === threadId) {
        setMessages(nextMessages);
        setThreadErrors((current) => ({ ...current, [threadId]: null }));
        setThreadRunStates((current) => ({
          ...current,
          [threadId]: current[threadId] === "error" ? "idle" : current[threadId] ?? "idle"
        }));
        unlockAutoFollow(threadId);
        scrollSoon();
      }
    } catch (caught) {
      const message = errorMessage(caught, "Failed to load messages.");
      setThreadError(threadId, message);
      setThreadRunState(threadId, "error");
    }
  }

  async function loadOlderMessages() {
    const threadId = activeThreadIdRef.current;
    const firstMessage = messages[0];
    if (!threadId || !firstMessage || loadingOlderMessages || !hasOlderMessages) return;
    setLoadingOlderMessages(true);
    const scroll = messageScrollRef.current;
    const previousScrollHeight = scroll?.scrollHeight ?? 0;
    try {
      const olderMessages = await getBridge().listMessages({
        threadId,
        limit: MESSAGE_PAGE_SIZE,
        before: {
          id: firstMessage.id,
          createdAt: firstMessage.createdAt
        }
      });
      if (activeThreadIdRef.current !== threadId) return;
      setMessages((current) => mergeMessages(olderMessages, current));
      window.setTimeout(() => {
        const nextScroll = messageScrollRef.current;
        if (!nextScroll) return;
        nextScroll.scrollTop += Math.max(0, nextScroll.scrollHeight - previousScrollHeight);
      }, 0);
    } catch (caught) {
      setThreadError(threadId, errorMessage(caught, "Failed to load earlier messages."));
    } finally {
      setLoadingOlderMessages(false);
    }
  }

  function resetChatState() {
    setMessages([]);
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    setThreadErrors((current) => ({ ...current, [threadId]: null }));
    setThreadRunStates((current) => ({
      ...current,
      [threadId]: isBusy(current[threadId]) ? current[threadId] : "idle"
    }));
  }

  async function sendMessage(content: string, providerId?: string, attachments: PickedPath[] = [], modelId?: string, memoryEnabled?: boolean, toolsEnabled = true, skillIds: string[] = [], webSearchEnabled?: boolean, reasoningEffort?: ReasoningEffort, inlineSkillIds: string[] = [], inlinePluginIds: string[] = [], targetThread?: ChatThread): Promise<boolean> {
    const thread = options.activeThread ?? targetThread ?? null;
    if ((!content.trim() && attachments.length === 0) || !thread) return false;

    const threadId = thread.id;
    if (isBusy(threadRunStates[threadId])) return false;
    if (targetThread && activeThreadIdRef.current !== threadId) {
      activeThreadIdRef.current = threadId;
    }
    const requestId = crypto.randomUUID();

    const requestContent = content.trim();
    const optimisticUser: ChatMessage = {
      id: `pending-${crypto.randomUUID()}`,
      threadId,
      role: "user",
      content: requestContent,
      attachments,
      createdAt: new Date().toISOString(),
      status: "sent"
    };

    setMessages((current) => activeThreadIdRef.current === threadId ? [...current, optimisticUser] : current);
    setThreadRunState(threadId, "running");
    setThreadRequestId(threadId, requestId);
    setThreadRunModel(threadId, modelId);
    setThreadError(threadId, null);
    unlockAutoFollow(threadId);
    scrollSoon();

    try {
      await getBridge().sendChatMessage({
        requestId,
        threadId,
        providerId,
        modelId,
        reasoningEffort,
        memoryEnabled,
        toolsEnabled,
        skillIds,
        inlineSkillIds,
        inlinePluginIds,
        webSearchEnabled,
        content: requestContent,
        attachments,
        // The main process rebuilds the full model history from the database
        // (see chat:send handler), so shipping the renderer's copy here only
        // duplicated the payload without affecting model context. Send an empty
        // array to keep the IPC message small on long threads.
        messages: []
      });

      setThreadRunState(threadId, "idle");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null);
      await refreshVisibleMessages(threadId);
      return true;
    } catch (caught) {
      const message = errorMessage(caught, "Provider request failed.");
      const errorMessageItem = createErrorMessage(threadId, message);
      setThreadError(threadId, message);
      setThreadRunState(threadId, "error");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null).catch(() => undefined);
      if (activeThreadIdRef.current === threadId) {
        const persistedMessages = await getBridge().listMessages({ threadId, limit: MESSAGE_PAGE_SIZE }).catch(() => null);
        setMessages([...(persistedMessages ?? messages), errorMessageItem]);
        scrollSoon();
      }
      return false;
    }
  }

  async function retryLastMessage(providerId?: string, messageId?: string, modelId?: string, memoryEnabled?: boolean, toolsEnabled = true, skillIds: string[] = [], webSearchEnabled?: boolean, reasoningEffort?: ReasoningEffort) {
    const threadId = options.activeThread?.id;
    if (!threadId || isBusy(threadRunStates[threadId])) return;
    const requestId = crypto.randomUUID();

    setMessages((current) => {
      if (messageId) {
        const retryIndex = current.findIndex((message) => message.id === messageId);
        return retryIndex >= 0 ? current.slice(0, retryIndex) : current;
      }
      const next = [...current];
      while (next.at(-1)?.role === "assistant" && next.at(-1)?.status === "error") {
        next.pop();
      }
      return next;
    });
    setThreadRunState(threadId, "running");
    setThreadRequestId(threadId, requestId);
    setThreadRunModel(threadId, modelId);
    setThreadError(threadId, null);
    unlockAutoFollow(threadId);
    scrollSoon();

    try {
      await getBridge().retryChatMessage({
        requestId,
        threadId,
        providerId,
        modelId,
        reasoningEffort,
        memoryEnabled,
        toolsEnabled,
        skillIds,
        webSearchEnabled,
        messageId
      });
      setThreadRunState(threadId, "idle");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null);
      await refreshVisibleMessages(threadId);
    } catch (caught) {
      const message = errorMessage(caught, "Provider request failed.");
      setThreadError(threadId, message);
      setThreadRunState(threadId, "error");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      if (activeThreadIdRef.current === threadId) {
        setMessages((current) => [...current, createErrorMessage(threadId, message)]);
        scrollSoon();
      }
    }
  }

  async function editMessage(messageId: string, content: string, providerId?: string, attachments: PickedPath[] = [], modelId?: string, memoryEnabled?: boolean, toolsEnabled = true, skillIds: string[] = [], webSearchEnabled?: boolean, reasoningEffort?: ReasoningEffort, inlineSkillIds?: string[], inlinePluginIds?: string[]): Promise<boolean> {
    const threadId = options.activeThread?.id;
    if ((!content.trim() && attachments.length === 0) || !threadId || isBusy(threadRunStates[threadId])) return false;
    const requestId = crypto.randomUUID();

    setMessages((current) => {
      const targetIndex = current.findIndex((message) => message.id === messageId);
      if (targetIndex < 0) return current;
      const next = current.slice(0, targetIndex + 1);
      next[targetIndex] = {
        ...next[targetIndex],
        content: content.trim(),
        attachments
      };
      return next;
    });
    setThreadRunState(threadId, "running");
    setThreadRequestId(threadId, requestId);
    setThreadRunModel(threadId, modelId);
    setThreadError(threadId, null);
    unlockAutoFollow(threadId);
    scrollSoon();

    try {
      await getBridge().editChatMessage({
        requestId,
        threadId,
        messageId,
        providerId,
        modelId,
        reasoningEffort,
        memoryEnabled,
        toolsEnabled,
        skillIds,
        inlineSkillIds,
        inlinePluginIds,
        webSearchEnabled,
        content,
        attachments
      });
      setThreadRunState(threadId, "idle");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null);
      await refreshVisibleMessages(threadId);
      return true;
    } catch (caught) {
      const message = errorMessage(caught, "Provider request failed.");
      setThreadError(threadId, message);
      setThreadRunState(threadId, "error");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null).catch(() => undefined);
      if (activeThreadIdRef.current === threadId) {
        const persistedMessages = await getBridge().listMessages({ threadId, limit: MESSAGE_PAGE_SIZE }).catch(() => null);
        setMessages([...(persistedMessages ?? []), createErrorMessage(threadId, message)]);
        scrollSoon();
      }
      return false;
    }
  }

  async function refreshVisibleMessages(threadId: string) {
    if (activeThreadIdRef.current !== threadId) return;
    const shouldStick = isMessageScrollNearBottom();
    const lockedScrollTop = shouldStick ? null : currentLockedScrollTop(threadId);
    const limit = Math.min(500, Math.max(MESSAGE_PAGE_SIZE, messagesRef.current.length + 8));
    const persistedMessages = await getBridge().listMessages({ threadId, limit }).catch(() => null);
    if (persistedMessages && activeThreadIdRef.current === threadId) {
      setMessages(persistedMessages);
      if (shouldStick) scrollSoon();
      else restoreScrollSoon(lockedScrollTop);
    }
  }

  async function queueMessage(content: string, attachments: PickedPath[] = [], mode: ChatQueueMode = "followUp"): Promise<boolean> {
    const threadId = activeThreadIdRef.current;
    if ((!content.trim() && attachments.length === 0) || !threadId || threadRunStates[threadId] !== "running") return false;
    const requestId = threadRequestIdsRef.current[threadId];
    if (!requestId) return false;
    try {
      const response = await getBridge().queueChatMessage({
        requestId,
        threadId,
        mode,
        content: content.trim(),
        attachments
      });
      setThreadQueue(threadId, response.queue);
      setThreadError(threadId, null);
      return true;
    } catch (caught) {
      const message = errorMessage(caught, "Failed to queue message.");
      setThreadError(threadId, message);
      return false;
    }
  }

  async function updateQueuedMessage(messageId: string, content: string, attachments: PickedPath[] = []): Promise<boolean> {
    const threadId = activeThreadIdRef.current;
    if ((!content.trim() && attachments.length === 0) || !threadId || threadRunStates[threadId] !== "running") return false;
    const requestId = threadRequestIdsRef.current[threadId];
    if (!requestId) return false;
    try {
      const response = await getBridge().updateQueuedChatMessage({
        requestId,
        threadId,
        messageId,
        content: content.trim(),
        attachments
      });
      setThreadQueue(threadId, response.queue);
      setThreadError(threadId, null);
      return true;
    } catch (caught) {
      setThreadError(threadId, errorMessage(caught, "Failed to update queued message."));
      return false;
    }
  }

  async function deleteQueuedMessage(messageId: string): Promise<boolean> {
    const threadId = activeThreadIdRef.current;
    if (!threadId || threadRunStates[threadId] !== "running") return false;
    const requestId = threadRequestIdsRef.current[threadId];
    if (!requestId) return false;
    try {
      const response = await getBridge().deleteQueuedChatMessage({
        requestId,
        threadId,
        messageId
      });
      setThreadQueue(threadId, response.queue);
      setThreadError(threadId, null);
      return true;
    } catch (caught) {
      setThreadError(threadId, errorMessage(caught, "Failed to delete queued message."));
      return false;
    }
  }

  async function steerQueuedMessage(messageId: string): Promise<boolean> {
    const threadId = activeThreadIdRef.current;
    if (!threadId || threadRunStates[threadId] !== "running") return false;
    const requestId = threadRequestIdsRef.current[threadId];
    if (!requestId) return false;
    try {
      const response = await getBridge().steerQueuedChatMessage({
        requestId,
        threadId,
        messageId
      });
      setThreadQueue(threadId, response.queue);
      setThreadError(threadId, null);
      return true;
    } catch (caught) {
      setThreadError(threadId, errorMessage(caught, "Failed to steer queued message."));
      return false;
    }
  }

  function setRunState(next: RunState | ((state: RunState) => RunState)) {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    setThreadRunStates((current) => {
      const currentState = current[threadId] ?? "idle";
      const nextState = typeof next === "function" ? next(currentState) : next;
      return { ...current, [threadId]: nextState };
    });
  }

  function setError(next: string | null) {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    setThreadError(threadId, next);
  }

  function setThreadRunState(threadId: string, next: RunState) {
    setThreadRunStates((current) => ({ ...current, [threadId]: next }));
  }

  function setThreadRunModel(threadId: string, modelLabel?: string) {
    if (!modelLabel) return;
    setThreadRunModels((current) => ({ ...current, [threadId]: modelLabel }));
  }

  function clearThreadRunModel(threadId: string) {
    setThreadRunModels((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }

  function setThreadError(threadId: string, next: string | null) {
    setThreadErrors((current) => ({ ...current, [threadId]: next }));
  }

  function setThreadQueue(threadId: string, next: ChatQueueState) {
    setThreadQueues((current) => ({ ...current, [threadId]: next }));
  }

  function clearThreadQueue(threadId: string) {
    setThreadQueues((current) => ({ ...current, [threadId]: EMPTY_QUEUE_STATE }));
  }

  function setThreadRequestId(threadId: string, requestId: string) {
    threadRequestIdsRef.current = { ...threadRequestIdsRef.current, [threadId]: requestId };
    setThreadRequestIds((current) => ({ ...current, [threadId]: requestId }));
  }

  function clearThreadRequestId(threadId: string) {
    const requestId = threadRequestIdsRef.current[threadId];
    if (requestId) liveStreamSnapshotsRef.current.delete(requestId);
    const refNext = { ...threadRequestIdsRef.current };
    delete refNext[threadId];
    threadRequestIdsRef.current = refNext;
    setThreadRequestIds((current) => {
      const next = { ...current };
      delete next[threadId];
      return next;
    });
  }

  function applyStreamEvent(event: ChatStreamEvent) {
    const snapshots = liveStreamSnapshotsRef.current;
    let liveSource: ChatStreamMessage[] | null = null;
    if (event.liveMessages?.length) {
      liveSource = event.liveMessages;
    } else if (event.delta) {
      const base = snapshots.get(event.requestId);
      // The first event of every request is a full snapshot, so a missing base
      // means this listener attached mid-run; skip until the next periodic
      // snapshot (sent every STREAM_SNAPSHOT_INTERVAL flushes) resyncs us.
      if (!base) return;
      liveSource = applyStreamDelta(base, event.delta);
    } else if (event.content !== undefined || event.timeline !== undefined) {
      liveSource = [{ role: "assistant", content: event.content ?? "", timeline: event.timeline }];
    }
    if (!liveSource) return;
    // Track snapshots even for background threads so switching back mid-stream
    // keeps deltas applicable. Bound the map in case runs end without cleanup.
    if (snapshots.size > 20 && !snapshots.has(event.requestId)) snapshots.clear();
    snapshots.set(event.requestId, liveSource);
    if (activeThreadIdRef.current !== event.threadId) return;
    const shouldStick = isMessageScrollNearBottom();
    const lockedScrollTop = shouldStick ? null : currentLockedScrollTop(event.threadId);
    const resolvedLive = liveSource;
    setMessages((current) => {
      const modelId = threadRunModelsRef.current[event.threadId];
      const baseCreatedAt = Date.now();
      const head = current.filter((message) => !isLiveMessageForRequest(message, event.requestId));
      const previousLive = new Map(
        current
          .filter((message) => isLiveMessageForRequest(message, event.requestId))
          .map((message) => [message.id, message] as const)
      );
      // Patch live messages in place against stable ids. Reuse the previous
      // object reference whenever a message is unchanged so settled bubbles do
      // not re-render (and never remount) while only the streaming tail advances.
      const live = resolvedLive.map<ChatMessage>((message, index) => {
        const id = `stream-${event.requestId}-${index}`;
        const next: ChatMessage = {
          id,
          threadId: event.threadId,
          role: message.role,
          content: message.content,
          attachments: message.attachments ?? [],
          timeline: message.timeline,
          createdAt: new Date(baseCreatedAt + index).toISOString(),
          status: "sent",
          modelId: message.role === "assistant" ? modelId : undefined
        };
        const prev = previousLive.get(id);
        return prev && sameLiveMessage(prev, next) ? prev : next;
      });
      return [...head, ...live];
    });
    if (shouldStick) scrollSoon();
    else restoreScrollSoon(lockedScrollTop);
  }

  async function stopActiveRun() {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    const requestId = threadRequestIdsRef.current[threadId];
    if (!requestId) return;
    const canceled = await getBridge().cancelChatMessage(requestId).catch(() => false);
    if (canceled) setThreadRunState(threadId, "stopping");
  }

  function scrollSoon() {
    scheduleScrollAdjust(() => {
      const scroll = messageScrollRef.current;
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    });
  }

  function restoreScrollSoon(scrollTop: number | null) {
    if (scrollTop === null) return;
    scheduleScrollAdjust(() => {
      const scroll = messageScrollRef.current;
      if (scroll) scroll.scrollTop = scrollTop;
    });
  }

  // Coalesce the many auto-follow scroll writes that arrive during streaming into a
  // single layout write per animation frame, so a fast stream cannot trigger a
  // read/write layout thrash loop on every ~45ms chunk.
  function scheduleScrollAdjust(apply: () => void) {
    pendingScrollActionRef.current = apply;
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const action = pendingScrollActionRef.current;
      pendingScrollActionRef.current = null;
      action?.();
    });
  }

  function currentLockedScrollTop(threadId: string): number | null {
    const scroll = messageScrollRef.current;
    return lockedScrollTopRef.current[threadId] ?? scroll?.scrollTop ?? null;
  }

  function isMessageScrollNearBottom(): boolean {
    const scroll = messageScrollRef.current;
    if (!scroll) return true;
    const threadId = activeThreadIdRef.current;
    if (threadId && autoFollowLockedThreadIdsRef.current.has(threadId)) return false;
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 96;
  }

  function onMessageWheel(deltaY: number) {
    const threadId = activeThreadIdRef.current;
    if (!threadId || !isBusy(threadRunStates[threadId])) return;
    if (deltaY < 0) autoFollowLockedThreadIdsRef.current.add(threadId);
  }

  function onMessageScroll() {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    const scroll = messageScrollRef.current;
    if (!scroll) return;
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 24) {
      unlockAutoFollow(threadId);
    } else if (autoFollowLockedThreadIdsRef.current.has(threadId)) {
      lockedScrollTopRef.current[threadId] = scroll.scrollTop;
    }
  }

  function unlockAutoFollow(threadId: string) {
    autoFollowLockedThreadIdsRef.current.delete(threadId);
    delete lockedScrollTopRef.current[threadId];
  }

  // Drops per-thread state for deleted threads so the run-state/queue/error maps
  // do not accumulate entries forever across long sessions (plan Phase 5.1).
  function pruneThreadState(threadIds: string[]) {
    if (threadIds.length === 0) return;
    const ids = new Set(threadIds);
    function omitDeleted<T>(record: Record<string, T>): Record<string, T> {
      if (!threadIds.some((id) => id in record)) return record;
      const next: Record<string, T> = {};
      for (const [key, value] of Object.entries(record)) {
        if (!ids.has(key)) next[key] = value;
      }
      return next;
    }
    for (const threadId of threadIds) {
      const requestId = threadRequestIdsRef.current[threadId];
      if (requestId) liveStreamSnapshotsRef.current.delete(requestId);
      unlockAutoFollow(threadId);
    }
    threadRequestIdsRef.current = omitDeleted(threadRequestIdsRef.current);
    setThreadRequestIds(omitDeleted);
    setThreadRunStates(omitDeleted);
    setThreadRunModels(omitDeleted);
    setThreadErrors(omitDeleted);
    setThreadQueues(omitDeleted);
  }

  return {
    messages,
    setMessages,
    hasOlderMessages,
    loadingOlderMessages,
    loadOlderMessages,
    runState,
    runModelLabel,
    setRunState,
    error,
    setError,
    queueState,
    messageScrollRef,
    resetChatState,
    pruneThreadState,
    sendMessage,
    queueMessage,
    updateQueuedMessage,
    deleteQueuedMessage,
    steerQueuedMessage,
    onMessageWheel,
    onMessageScroll,
    retryLastMessage,
    editMessage,
    stopActiveRun
  };
}

function mergeMessages(olderMessages: ChatMessage[], currentMessages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const merged: ChatMessage[] = [];
  for (const message of [...olderMessages, ...currentMessages]) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

function isBusy(state: RunState | undefined): boolean {
  return state === "running" || state === "stopping";
}

const EMPTY_QUEUE_STATE: ChatQueueState = { followUp: [], steering: [] };

function isLiveMessageForRequest(message: ChatMessage, requestId: string): boolean {
  return message.id === `stream-${requestId}` || message.id.startsWith(`stream-${requestId}-`);
}

function createErrorMessage(threadId: string, message: string): ChatMessage {
  return {
    id: `error-${crypto.randomUUID()}`,
    threadId,
    role: "assistant",
    content: `Request failed: ${message}`,
    createdAt: new Date().toISOString(),
    status: "error"
  };
}

function sameLiveMessage(previous: ChatMessage, next: ChatMessage): boolean {
  return (
    previous.id === next.id &&
    previous.threadId === next.threadId &&
    previous.role === next.role &&
    previous.content === next.content &&
    previous.status === next.status &&
    previous.modelId === next.modelId &&
    sameAttachments(previous.attachments ?? [], next.attachments ?? []) &&
    sameTimeline(previous.timeline ?? [], next.timeline ?? [])
  );
}

function sameAttachments(previous: PickedPath[], next: PickedPath[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((item, index) => {
    const other = next[index];
    return Boolean(other)
      && item.kind === other.kind
      && item.path === other.path
      && item.name === other.name
      && item.isImage === other.isImage
      && item.mediaType === other.mediaType
      && item.previewDataUrl === other.previewDataUrl;
  });
}

function sameTimeline(previous: ChatTimelineItem[], next: ChatTimelineItem[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((item, index) => sameTimelineItem(item, next[index]));
}

// Field-wise comparison avoids the per-item JSON.stringify that previously ran on
// every stream tick (which is O(size of timeline) and dominated by large tool output).
function sameTimelineItem(previous: ChatTimelineItem, next: ChatTimelineItem): boolean {
  if (previous === next) return true;
  if (previous.id !== next.id || previous.kind !== next.kind) return false;
  switch (previous.kind) {
    case "thinking":
      return next.kind === "thinking" && previous.text === next.text;
    case "assistant_text":
      return next.kind === "assistant_text" && previous.text === next.text;
    case "tool_call":
      return (
        next.kind === "tool_call" &&
        previous.toolName === next.toolName &&
        previous.title === next.title &&
        previous.argumentsJson === next.argumentsJson
      );
    case "tool_result":
      return (
        next.kind === "tool_result" &&
        previous.toolName === next.toolName &&
        previous.title === next.title &&
        previous.content === next.content &&
        Boolean(previous.isError) === Boolean(next.isError)
      );
    case "system":
      return (
        next.kind === "system" &&
        previous.title === next.title &&
        previous.text === next.text &&
        previous.customType === next.customType &&
        previous.origin === next.origin &&
        previous.data === next.data
      );
    default:
      return false;
  }
}
