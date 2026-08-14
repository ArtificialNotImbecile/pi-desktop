import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, ChatQueueMode, ChatQueueState, ChatStreamEvent, ChatStreamMessage, ChatStreamSettlement, ChatThread, ChatTimelineItem, MessageListRequest, PickedPath, PluginReference, ReasoningEffort, SkillReference } from "../../shared/ipc";
import { applyStreamDelta } from "../../shared/streamDelta";
import { applyChatStreamSettlement, chatStreamPrefixRenderId, chatStreamRenderId } from "../../shared/streamSettlement";
import type { RunState } from "../types";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

const MESSAGE_PAGE_SIZE = 160;
const COALESCED_TAIL_SNAP_THRESHOLD_PX = 96;

declare global {
  interface Window {
    __JASMINE_MESSAGE_LOAD_DELAYS__?: Record<string, number[]>;
  }
}

type RunLoadBoundary = {
  replaceAfterMessageId?: string;
  prefix: ChatMessage[];
  appendPersistedWhenUnanchored?: boolean;
};

type MessageContentAnchor = {
  messageId: string;
  contentTop: number;
};

type VisibleStreamCommitPayload =
  | {
      kind: "stream-frame";
      requestId: string;
      threadId: string;
      liveMessages: ChatStreamMessage[];
    }
  | {
      kind: "settlement";
      requestId: string;
      threadId: string;
      settlement: ChatStreamSettlement;
    }
  | {
      kind: "loaded-messages";
      threadId: string;
      messages: ChatMessage[];
      requestId?: string;
    };

type VisibleStreamCommit = VisibleStreamCommitPayload & { generation: number };

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
  const pendingScrollActionRef = useRef<{ apply: () => void; priority: number } | null>(null);
  const tailScrollAnimationRef = useRef<number | null>(null);
  const pendingInitialTailJumpThreadRef = useRef<string | null>(null);
  const pendingMessageAnchorRestoreRef = useRef<{
    threadId: string;
    anchor: MessageContentAnchor;
  } | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollGenerationRef = useRef(0);
  const lastObservedScrollTopRef = useRef(0);
  const lastObservedScrollHeightRef = useRef(0);
  // Last reconstructed live-message array per requestId, used as the base when the
  // main process streams incremental deltas instead of full snapshots.
  const liveStreamSnapshotsRef = useRef<Map<string, ChatStreamMessage[]>>(new Map());
  const settledRequestIdsRef = useRef<Set<string>>(new Set());
  const settledRequestStatusesRef = useRef<Map<string, ChatStreamEvent["status"]>>(new Map());
  const settlementWaitersRef = useRef<Map<string, () => void>>(new Map());
  const latestSettlementsByThreadRef = useRef<Map<string, { requestId: string; settlement: ChatStreamSettlement }>>(new Map());
  const runLoadBoundariesRef = useRef<Map<string, RunLoadBoundary>>(new Map());
  const messageLoadEpochRef = useRef(0);
  const pendingInitialLoadsRef = useRef<Map<string, { epoch: number; promotedRequestId?: string; associatedRequestId?: string }>>(new Map());
  // Provider events remain authoritative immediately in liveStreamSnapshotsRef.
  // Visible React publication follows the browser's paint clock. If provider
  // events outrun requestAnimationFrame, only their newest cumulative snapshot
  // is useful: replaying every intermediate prefix makes the UI visibly lag the
  // model and is the source of the old start-stop reveal.
  const visibleStreamQueueRef = useRef<VisibleStreamCommit[]>([]);
  const visibleStreamFrameRef = useRef<number | null>(null);
  const visibleStreamCommitRef = useRef<VisibleStreamCommit | null>(null);
  // The queued cursor is authoritative for hidden-window/load reconciliation;
  // the visible cursor tracks the snapshot React has actually committed.
  const visibleStreamQueuedSnapshotsRef = useRef<Map<string, ChatStreamMessage[]>>(new Map());
  const visibleStreamSnapshotsRef = useRef<Map<string, ChatStreamMessage[]>>(new Map());
  const visibleStreamGenerationRef = useRef(0);

  const activeThreadId = options.activeThread?.id ?? null;
  const runState = activeThreadId ? threadRunStates[activeThreadId] ?? "idle" : "idle";
  const runModelLabel = activeThreadId ? threadRunModels[activeThreadId] ?? null : null;
  const error = activeThreadId ? threadErrors[activeThreadId] ?? null : null;
  // The shared EMPTY_QUEUE_STATE constant keeps this reference stable across
  // renders so memoized consumers (Composer) are not invalidated per stream tick.
  const queueState = activeThreadId ? threadQueues[activeThreadId] ?? EMPTY_QUEUE_STATE : EMPTY_QUEUE_STATE;
  const hasOlderMessages = Boolean(options.activeThread && messages.length > 0 && messages.length < options.activeThread.messageCount);

  useLayoutEffect(() => {
    if (activeThreadIdRef.current !== activeThreadId) discardVisibleStreamCommits();
    activeThreadIdRef.current = activeThreadId;
    const loadEpoch = ++messageLoadEpochRef.current;
    // Thread selection is an explicit navigation intent. Do this before the
    // async list request so neither a stale lock nor an early pointer event on
    // the selected sidebar row can turn the initial tail jump into a no-op.
    if (activeThreadId) unlockAutoFollow(activeThreadId);
    if (activeThreadId) {
      const currentRequestId = threadRequestIdsRef.current[activeThreadId];
      const stagedCurrentRun = Boolean(
        currentRequestId
        && messagesRef.current.length > 0
        && messagesRef.current.every((message) => message.threadId === activeThreadId)
        && messagesRef.current.some((message) => isStagedMessageForRequest(message, currentRequestId))
      );
      // A first send from a project/new-chat route creates and selects its
      // thread inside the submit handler. That run is already staged before
      // React delivers the new activeThread prop, so clearing here would make
      // the optimistic user row disappear until persistence catches up.
      if (!stagedCurrentRun) {
        // The previous thread's rows must never be used as the baseline for a
        // stream event that lands while this thread's database page is loading.
        messagesRef.current = [];
        setMessages([]);
      }
      pendingInitialLoadsRef.current.set(activeThreadId, {
        epoch: loadEpoch,
        ...(stagedCurrentRun && currentRequestId ? { promotedRequestId: currentRequestId } : {}),
        ...(currentRequestId ? { associatedRequestId: currentRequestId } : {})
      });
      void loadMessages(activeThreadId, loadEpoch);
    } else {
      messagesRef.current = [];
      setMessages([]);
    }
  }, [activeThreadId]);

  useEffect(() => {
    return getBridge().onChatStream((event) => {
      // Title generation lands mid-stream; patch the one thread locally instead
      // of re-listing every thread (which used to cost a full listThreads IPC).
      if (event.threadTitle) patchThreadRef.current(event.threadId, { title: event.threadTitle });
      if (event.queue) setThreadQueue(event.threadId, event.queue);
      if (event.settlement) applyStreamSettlement(event);
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

  // Run after React commits each message batch, before it is painted. Scheduling
  // only from the stream callback can race a concurrent render and read the old
  // scrollHeight, which is how a freshly loaded long thread used to remain near
  // its first message. The initial load is an unpainted navigation jump; later
  // streaming commits enter the bounded per-frame follower.
  useLayoutEffect(() => {
    const threadId = activeThreadIdRef.current;
    const scroll = messageScrollRef.current;
    if (threadId && scroll) {
      const pendingMessageAnchor = pendingMessageAnchorRestoreRef.current;
      if (pendingMessageAnchor?.threadId === threadId) {
        pendingMessageAnchorRestoreRef.current = null;
        restoreMessageAnchor(threadId, pendingMessageAnchor.anchor);
      }
    }
    const committed = visibleStreamCommitRef.current;
    // Coalescing deliberately skips stale cumulative prefixes. If an expensive
    // Markdown/Shiki render lets the newest snapshot grow by several lines at
    // once, the ordinary 16px follower cannot keep the tail visible. Correct a
    // large gap in this pre-paint layout phase so the reader sees the newest
    // content and its matching scroll position in the same painted frame.
    if (threadId && scroll && committed?.kind === "stream-frame" && shouldAutoFollow(threadId)) {
      snapCoalescedTailBeforePaint(scroll);
    }
    // Anchor correction must precede both commit acknowledgement (which can
    // schedule the next visual batch) and the bounded tail follower.
    finishVisibleStreamCommit();
    if (!threadId || !scroll) return;
    if (!shouldAutoFollow(threadId)) return;
    if (pendingInitialTailJumpThreadRef.current === threadId) {
      pendingInitialTailJumpThreadRef.current = null;
      stopTailScrollAnimation();
      writeScrollTop(scroll, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
      return;
    }
    animateScrollToTail(scroll);
  }, [messages]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
      if (tailScrollAnimationRef.current !== null) window.cancelAnimationFrame(tailScrollAnimationRef.current);
      discardVisibleStreamCommits();
      for (const resolve of settlementWaitersRef.current.values()) resolve();
      settlementWaitersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (isVisualCommitSuspended()) {
        // Browsers may stop requestAnimationFrame entirely for a hidden window.
        // There is nothing to animate offscreen, so keep only the authoritative
        // cursor and discard visual intermediates before they can accumulate.
        const threadId = activeThreadIdRef.current;
        const currentRequestId = threadId ? threadRequestIdsRef.current[threadId] : undefined;
        const settled = threadId ? latestSettlementsByThreadRef.current.get(threadId) : undefined;
        discardVisibleStreamCommits();
        // If a terminal commit was waiting for its next paint, converge to that
        // canonical state now. Otherwise discard would resolve its waiter while
        // leaving the last live frame on screen when the window is restored.
        if (threadId && settled && settled.requestId === currentRequestId) {
          applyTerminalSettlementNow(threadId, settled.settlement);
        }
        return;
      }
      const threadId = activeThreadIdRef.current;
      const requestId = threadId ? threadRequestIdsRef.current[threadId] : undefined;
      const liveMessages = requestId ? liveStreamSnapshotsRef.current.get(requestId) : undefined;
      if (threadId && requestId && liveMessages && !settledRequestIdsRef.current.has(requestId)) {
        enqueueVisibleStreamCommit({ kind: "stream-frame", requestId, threadId, liveMessages });
        visibleStreamQueuedSnapshotsRef.current.set(requestId, liveMessages);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  async function loadMessages(threadId: string, loadEpoch: number) {
    try {
      const persistedMessages = await listMessagesForLoad({ threadId, limit: MESSAGE_PAGE_SIZE });
      const pendingLoad = pendingInitialLoadsRef.current.get(threadId);
      const promotedRequestId = pendingLoad?.epoch === loadEpoch ? pendingLoad.promotedRequestId : undefined;
      const currentRequestId = threadRequestIdsRef.current[threadId];
      const associatedRequestId = pendingLoad?.epoch === loadEpoch ? pendingLoad.associatedRequestId : undefined;
      const promotedToCurrentRun = Boolean(
        activeThreadIdRef.current === threadId
        && promotedRequestId
        && promotedRequestId === currentRequestId
      );
      if (!isCurrentMessageLoad(threadId, loadEpoch) && !promotedToCurrentRun) {
        if (pendingLoad?.epoch === loadEpoch) {
          pendingInitialLoadsRef.current.delete(threadId);
          if (promotedRequestId) runLoadBoundariesRef.current.delete(promotedRequestId);
        }
        return;
      }
      const nextMessages = messagesForLoadedThread(threadId, persistedMessages);
      const visibleRequestId = currentRequestId ?? associatedRequestId;
      const currentRunAlreadyVisible = Boolean(
        visibleRequestId
        && activeThreadIdRef.current === threadId
        && (
          visibleStreamSnapshotsRef.current.has(visibleRequestId)
          || visibleStreamQueuedSnapshotsRef.current.has(visibleRequestId)
          || messagesRef.current.some((message) => isLiveMessageForRequest(message, visibleRequestId))
          || latestSettlementsByThreadRef.current.get(threadId)?.requestId === visibleRequestId
          || (visibleStreamCommitRef.current !== null
            && "requestId" in visibleStreamCommitRef.current
            && visibleStreamCommitRef.current.requestId === visibleRequestId)
          || visibleStreamQueueRef.current.some((commit) => "requestId" in commit && commit.requestId === visibleRequestId)
        )
      );
      if (promotedToCurrentRun || currentRunAlreadyVisible) {
        enqueueVisibleStreamCommit({
          kind: "loaded-messages",
          threadId,
          messages: nextMessages,
          requestId: visibleRequestId
        });
      } else {
        const shouldStick = shouldAutoFollow(threadId);
        const lockedScrollTop = shouldStick ? null : currentLockedScrollTop(threadId);
        const readingAnchor = shouldStick ? null : captureVisibleTimelineAnchor();
        if (readingAnchor) prepareTimelineAnchorRestore(threadId, readingAnchor);
        if (shouldStick) pendingInitialTailJumpThreadRef.current = threadId;
        setMessages((current) => reconcileRenderedMessages(current, nextMessages));
        if (!shouldStick) restoreScrollSoon(threadId, lockedScrollTop, readingAnchor);
      }
      setThreadErrors((current) => ({ ...current, [threadId]: null }));
      setThreadRunStates((current) => ({
        ...current,
        [threadId]: current[threadId] === "error" ? "idle" : current[threadId] ?? "idle"
      }));
      pendingInitialLoadsRef.current.delete(threadId);
      if (promotedRequestId && (
        settledRequestIdsRef.current.has(promotedRequestId)
        || threadRequestIdsRef.current[threadId] !== promotedRequestId
      )) {
        runLoadBoundariesRef.current.delete(promotedRequestId);
      }
    } catch (caught) {
      const pendingLoad = pendingInitialLoadsRef.current.get(threadId);
      if (pendingLoad?.epoch === loadEpoch) {
        pendingInitialLoadsRef.current.delete(threadId);
        if (pendingLoad.promotedRequestId && (
          settledRequestIdsRef.current.has(pendingLoad.promotedRequestId)
          || threadRequestIdsRef.current[threadId] !== pendingLoad.promotedRequestId
        )) {
          runLoadBoundariesRef.current.delete(pendingLoad.promotedRequestId);
        }
      }
      if (!isCurrentMessageLoad(threadId, loadEpoch)) return;
      const promotedRequestId = pendingLoad?.promotedRequestId;
      const message = errorMessage(caught, "Failed to load messages.");
      setThreadError(threadId, message);
      // Losing the historical baseline must not make an otherwise active model
      // run look idle/error and re-enable a second concurrent send.
      if (!promotedRequestId || threadRequestIdsRef.current[threadId] !== promotedRequestId) {
        setThreadRunState(threadId, "error");
      }
    }
  }

  function isCurrentMessageLoad(threadId: string, loadEpoch: number): boolean {
    return activeThreadIdRef.current === threadId && messageLoadEpochRef.current === loadEpoch;
  }

  async function listMessagesForLoad(request: MessageListRequest): Promise<ChatMessage[]> {
    const persisted = await getBridge().listMessages(request);
    // Deterministic E2E-only response delay used to exercise A -> B -> A and
    // settlement/list ordering. The database read already completed, so this
    // models an old IPC response arriving after newer renderer state.
    const delayQueue = window.__JASMINE_HARNESS_ENABLED__
      ? window.__JASMINE_MESSAGE_LOAD_DELAYS__?.[request.threadId]
      : undefined;
    const delayMs = delayQueue?.shift() ?? 0;
    if (delayMs > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
    return persisted;
  }

  function messagesForLoadedThread(threadId: string, persistedMessages: ChatMessage[]): ChatMessage[] {
    const settled = latestSettlementsByThreadRef.current.get(threadId);
    const pendingRequestId = pendingInitialLoadsRef.current.get(threadId)?.promotedRequestId;
    const requestId = threadRequestIdsRef.current[threadId] ?? pendingRequestId;
    const boundary = requestId ? runLoadBoundariesRef.current.get(requestId) : undefined;
    const baseline = boundary ? applyRunLoadBoundary(persistedMessages, boundary) : persistedMessages;
    // A prior run's settlement may still be needed to correct an old in-flight
    // list response, but it must never hide a newer active run after A -> B -> A.
    if (settled && (!requestId || settled.requestId === requestId)) {
      return applyChatStreamSettlement(baseline, settled.settlement);
    }
    if (!requestId) return baseline;
    const liveSnapshot = liveStreamSnapshotsRef.current.get(requestId);
    if (!liveSnapshot) return baseline;
    return [
      ...baseline.filter((message) => !isLiveMessageForRequest(message, requestId)),
      ...toLiveChatMessages(
        requestId,
        threadId,
        liveSnapshot,
        threadRunModelsRef.current[threadId]
      )
    ];
  }

  async function loadOlderMessages() {
    const threadId = activeThreadIdRef.current;
    const firstMessage = messages[0];
    if (!threadId || !firstMessage || loadingOlderMessages || !hasOlderMessages) return;
    setLoadingOlderMessages(true);
    const scroll = messageScrollRef.current;
    const readingAnchor = captureFirstVisibleMessageAnchor(scroll);
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
      if (readingAnchor && olderMessages.length > 0) prepareMessageAnchorRestore(threadId, readingAnchor);
      setMessages((current) => mergeMessages(olderMessages, current));
    } catch (caught) {
      setThreadError(threadId, errorMessage(caught, "Failed to load earlier messages."));
    } finally {
      setLoadingOlderMessages(false);
    }
  }

  function resetChatState() {
    discardVisibleStreamCommits();
    setMessages([]);
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    setThreadErrors((current) => ({ ...current, [threadId]: null }));
    setThreadRunStates((current) => ({
      ...current,
      [threadId]: isBusy(current[threadId]) ? current[threadId] : "idle"
    }));
  }

  async function sendMessage(content: string, providerId?: string, attachments: PickedPath[] = [], modelId?: string, memoryEnabled?: boolean, toolsEnabled = true, skillIds: string[] = [], reasoningEffort?: ReasoningEffort, inlineSkillIds: string[] = [], inlinePluginIds: string[] = [], targetThread?: ChatThread, optimisticSkillsUsed: SkillReference[] = [], optimisticPluginsUsed: PluginReference[] = [], captureContextTaxonomy = false): Promise<boolean> {
    const thread = options.activeThread ?? targetThread ?? null;
    if ((!content.trim() && attachments.length === 0) || !thread) return false;

    const threadId = thread.id;
    if (isBusy(threadRunStates[threadId])) return false;
    const switchingVisibleThread = activeThreadIdRef.current !== threadId;
    if (targetThread && switchingVisibleThread) {
      activeThreadIdRef.current = threadId;
    }
    const requestId = crypto.randomUUID();
    const visibleBaseline = switchingVisibleThread
      ? []
      : messagesRef.current.every((message) => message.threadId === threadId)
        ? messagesRef.current
        : [];
    const existingMessageIds = new Set(visibleBaseline.map((message) => message.id));

    const requestContent = content.trim();
    const optimisticUser: ChatMessage = {
      id: chatStreamPrefixRenderId(requestId, 0),
      renderId: chatStreamPrefixRenderId(requestId, 0),
      threadId,
      role: "user",
      content: requestContent,
      attachments,
      skillsUsed: optimisticSkillsUsed,
      pluginsUsed: optimisticPluginsUsed,
      createdAt: new Date().toISOString(),
      status: "sent"
    };

    const optimisticMessages = [...visibleBaseline, optimisticUser];
    const hasPendingInitialLoad = Boolean(pendingInitialLoadsRef.current.get(threadId));
    runLoadBoundariesRef.current.set(requestId, {
      ...(hasPendingInitialLoad ? {} : { replaceAfterMessageId: lastStableMessageId(visibleBaseline) }),
      prefix: hasPendingInitialLoad ? optimisticMessages : [optimisticUser],
      appendPersistedWhenUnanchored: hasPendingInitialLoad
    });
    messagesRef.current = optimisticMessages;
    setMessages(optimisticMessages);
    setThreadRunState(threadId, "running");
    setThreadRequestId(threadId, requestId);
    const settlementPromise = waitForSettlement(requestId);
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
        captureContextTaxonomy,
        skillIds,
        inlineSkillIds,
        inlinePluginIds,
        content: requestContent,
        attachments,
        // The main process rebuilds the full model history from the database
        // (see chat:send handler), so shipping the renderer's copy here only
        // duplicated the payload without affecting model context. Send an empty
        // array to keep the IPC message small on long threads.
        messages: []
      });

      await awaitSettlementOrTimeout(requestId, settlementPromise);
      settlementWaitersRef.current.delete(requestId);
      setThreadRunState(threadId, "idle");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null);
      if (!settledRequestIdsRef.current.has(requestId)) await refreshVisibleMessages(threadId);
      clearSettledRequest(requestId);
      return true;
    } catch (caught) {
      await awaitSettlementOrTimeout(requestId, settlementPromise);
      settlementWaitersRef.current.delete(requestId);
      if (settledRequestStatusesRef.current.get(requestId) === "aborted") {
        await finishAbortedRequest(threadId, requestId);
        return true;
      }
      const failureReconcile = beginProviderFailureReconcile(threadId, requestId);
      clearSettledRequest(requestId);
      const message = errorMessage(caught, "Provider request failed.");
      const errorMessageItem = createErrorMessage(threadId, message);
      setThreadError(threadId, message);
      setThreadRunState(threadId, "error");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null).catch(() => undefined);
      await reconcileProviderFailure(threadId, requestId, failureReconcile, existingMessageIds, errorMessageItem);
      return false;
    }
  }

  async function retryLastMessage(providerId?: string, messageId?: string, modelId?: string, memoryEnabled?: boolean, toolsEnabled = true, skillIds: string[] = [], reasoningEffort?: ReasoningEffort, captureContextTaxonomy = false) {
    const threadId = options.activeThread?.id;
    if (!threadId || isBusy(threadRunStates[threadId])) return;
    const requestId = crypto.randomUUID();
    const existingMessageIds = new Set(messagesRef.current.map((message) => message.id));

    const retryBaseline = messagesForRetry(messagesRef.current, messageId);
    runLoadBoundariesRef.current.set(requestId, {
      replaceAfterMessageId: lastStableMessageId(retryBaseline),
      prefix: []
    });
    setMessages(() => {
      return retryBaseline;
    });
    setThreadRunState(threadId, "running");
    setThreadRequestId(threadId, requestId);
    const settlementPromise = waitForSettlement(requestId);
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
        captureContextTaxonomy,
        skillIds,
        messageId
      });
      await awaitSettlementOrTimeout(requestId, settlementPromise);
      settlementWaitersRef.current.delete(requestId);
      setThreadRunState(threadId, "idle");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null);
      if (!settledRequestIdsRef.current.has(requestId)) await refreshVisibleMessages(threadId);
      clearSettledRequest(requestId);
    } catch (caught) {
      await awaitSettlementOrTimeout(requestId, settlementPromise);
      settlementWaitersRef.current.delete(requestId);
      if (settledRequestStatusesRef.current.get(requestId) === "aborted") {
        await finishAbortedRequest(threadId, requestId);
        return;
      }
      const failureReconcile = beginProviderFailureReconcile(threadId, requestId);
      clearSettledRequest(requestId);
      const message = errorMessage(caught, "Provider request failed.");
      setThreadError(threadId, message);
      setThreadRunState(threadId, "error");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null).catch(() => undefined);
      await reconcileProviderFailure(
        threadId,
        requestId,
        failureReconcile,
        existingMessageIds,
        createErrorMessage(threadId, message)
      );
    }
  }

  async function editMessage(messageId: string, content: string, providerId?: string, attachments: PickedPath[] = [], modelId?: string, memoryEnabled?: boolean, toolsEnabled = true, skillIds: string[] = [], reasoningEffort?: ReasoningEffort, inlineSkillIds?: string[], inlinePluginIds?: string[], optimisticSkillsUsed: SkillReference[] = [], optimisticPluginsUsed: PluginReference[] = [], captureContextTaxonomy = false): Promise<boolean> {
    const threadId = options.activeThread?.id;
    if ((!content.trim() && attachments.length === 0) || !threadId || isBusy(threadRunStates[threadId])) return false;
    const requestId = crypto.randomUUID();
    const existingMessageIds = new Set(messagesRef.current.map((message) => message.id));

    const editBaseline = messagesForEdit(
      messagesRef.current,
      messageId,
      content,
      attachments,
      optimisticSkillsUsed,
      optimisticPluginsUsed
    );
    const editedMessage = editBaseline.at(-1);
    runLoadBoundariesRef.current.set(requestId, {
      replaceAfterMessageId: lastStableMessageId(editBaseline.slice(0, -1)),
      prefix: editedMessage ? [editedMessage] : []
    });
    setMessages(() => editBaseline);
    setThreadRunState(threadId, "running");
    setThreadRequestId(threadId, requestId);
    const settlementPromise = waitForSettlement(requestId);
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
        captureContextTaxonomy,
        skillIds,
        inlineSkillIds,
        inlinePluginIds,
        content,
        attachments
      });
      await awaitSettlementOrTimeout(requestId, settlementPromise);
      settlementWaitersRef.current.delete(requestId);
      setThreadRunState(threadId, "idle");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null);
      if (!settledRequestIdsRef.current.has(requestId)) await refreshVisibleMessages(threadId);
      clearSettledRequest(requestId);
      return true;
    } catch (caught) {
      await awaitSettlementOrTimeout(requestId, settlementPromise);
      settlementWaitersRef.current.delete(requestId);
      if (settledRequestStatusesRef.current.get(requestId) === "aborted") {
        await finishAbortedRequest(threadId, requestId);
        return true;
      }
      const failureReconcile = beginProviderFailureReconcile(threadId, requestId);
      clearSettledRequest(requestId);
      const message = errorMessage(caught, "Provider request failed.");
      setThreadError(threadId, message);
      setThreadRunState(threadId, "error");
      clearThreadQueue(threadId);
      clearThreadRequestId(threadId);
      clearThreadRunModel(threadId);
      await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null).catch(() => undefined);
      await reconcileProviderFailure(
        threadId,
        requestId,
        failureReconcile,
        existingMessageIds,
        createErrorMessage(threadId, message)
      );
      return false;
    }
  }

  function beginProviderFailureReconcile(
    threadId: string,
    requestId: string
  ): { loadEpoch: number; boundary?: RunLoadBoundary } | null {
    if (activeThreadIdRef.current !== threadId) return null;
    return {
      loadEpoch: ++messageLoadEpochRef.current,
      boundary: runLoadBoundariesRef.current.get(requestId)
    };
  }

  async function reconcileProviderFailure(
    threadId: string,
    requestId: string,
    failure: { loadEpoch: number; boundary?: RunLoadBoundary } | null,
    existingMessageIds: ReadonlySet<string>,
    transientError: ChatMessage
  ): Promise<void> {
    if (!failure || !isCurrentMessageLoad(threadId, failure.loadEpoch)) return;
    // Retry/edit failures may need to restore a tail that the optimistic UI
    // deliberately truncated before generation. Read at least the number of
    // messages visible when the operation started; a fixed latest-page read can
    // omit an early anchor and permanently drop the loaded middle segment.
    const persistedMessages = await listMessagesForLoad({
      threadId,
      limit: Math.max(MESSAGE_PAGE_SIZE, existingMessageIds.size + 8)
    }).catch(() => null);
    if (!isCurrentMessageLoad(threadId, failure.loadEpoch)) return;
    setMessages((current) => {
      // The updater can be deferred until after a navigation or a newer run.
      // Recheck both guards here so an A failure can never write into B.
      if (!isCurrentMessageLoad(threadId, failure.loadEpoch)) return current;
      const persistedWithRenderIdentity = persistedMessages
        ? carryFailedSendRenderIdentity(persistedMessages, current, requestId, existingMessageIds)
        : null;
      const authoritativeRunTail = persistedWithRenderIdentity
        ? mergeFailedRunPage(current, persistedWithRenderIdentity, failure.boundary)
        : null;
      const next = reconcileRenderedMessages(
        current,
        withTransientErrorFallback(authoritativeRunTail, current, existingMessageIds, transientError)
      );
      messagesRef.current = next;
      return next;
    });
    if (isCurrentMessageLoad(threadId, failure.loadEpoch)) scrollSoon();
  }

  async function refreshVisibleMessages(threadId: string) {
    if (activeThreadIdRef.current !== threadId) return;
    const loadEpoch = ++messageLoadEpochRef.current;
    const shouldStick = shouldAutoFollow(threadId);
    const lockedScrollTop = shouldStick ? null : currentLockedScrollTop(threadId);
    const limit = Math.min(500, Math.max(MESSAGE_PAGE_SIZE, messagesRef.current.length + 8));
    const persistedMessages = await getBridge().listMessages({ threadId, limit }).catch(() => null);
    if (persistedMessages && isCurrentMessageLoad(threadId, loadEpoch)) {
      const nextMessages = messagesForLoadedThread(threadId, persistedMessages);
      setMessages((current) => reconcileRenderedMessages(current, nextMessages));
      if (shouldStick) scrollSoon();
      else restoreScrollSoon(threadId, lockedScrollTop);
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
    // A new operation owns the visible tail. Do not let any not-yet-committed
    // snapshots from the previous request land after its optimistic baseline.
    discardVisibleStreamCommits();
    // A pending initial page is promoted into the current run only when the run
    // boundary knows how to merge it with the optimistic/live tail. Otherwise
    // invalidate that old read before it can overwrite newer renderer state.
    const pendingLoad = pendingInitialLoadsRef.current.get(threadId);
    const boundary = runLoadBoundariesRef.current.get(requestId);
    if (pendingLoad && boundary?.appendPersistedWhenUnanchored) {
      const previousPromotedRequestId = pendingLoad.promotedRequestId;
      pendingLoad.promotedRequestId = requestId;
      pendingLoad.associatedRequestId = requestId;
      if (previousPromotedRequestId && previousPromotedRequestId !== requestId) {
        runLoadBoundariesRef.current.delete(previousPromotedRequestId);
      }
    } else {
      pendingInitialLoadsRef.current.delete(threadId);
      messageLoadEpochRef.current += 1;
    }
    latestSettlementsByThreadRef.current.delete(threadId);
    threadRequestIdsRef.current = { ...threadRequestIdsRef.current, [threadId]: requestId };
    setThreadRequestIds((current) => ({ ...current, [threadId]: requestId }));
  }

  function clearThreadRequestId(threadId: string) {
    const requestId = threadRequestIdsRef.current[threadId];
    if (requestId) {
      liveStreamSnapshotsRef.current.delete(requestId);
      // A provider that never sends settlement can leave paced live work
      // behind a database/error fallback. Invalidate that request before the
      // authoritative fallback lands so stale deltas cannot overwrite it.
      if (!settledRequestIdsRef.current.has(requestId)) {
        discardVisibleStreamCommitsForRequest(requestId);
      }
      if (pendingInitialLoadsRef.current.get(threadId)?.promotedRequestId !== requestId) {
        runLoadBoundariesRef.current.delete(requestId);
      }
    }
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
    if (settledRequestIdsRef.current.has(event.requestId)) return;
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
    if (isVisualCommitSuspended()) {
      // The authoritative cursor above is sufficient to resume from one reset;
      // never grow a visual backlog while the browser has paused painting.
      discardVisibleStreamCommits();
      visibleStreamQueuedSnapshotsRef.current.set(event.requestId, liveSource);
      return;
    }
    enqueueVisibleStreamCommit({
      kind: "stream-frame",
      requestId: event.requestId,
      threadId: event.threadId,
      liveMessages: liveSource
    });
    visibleStreamQueuedSnapshotsRef.current.set(event.requestId, liveSource);
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
      if (scroll) animateScrollToTail(scroll);
    });
  }

  function enqueueVisibleStreamCommit(payload: VisibleStreamCommitPayload): void {
    const commit: VisibleStreamCommit = {
      ...payload,
      generation: visibleStreamGenerationRef.current
    };
    if (activeThreadIdRef.current !== commit.threadId) {
      if (commit.kind === "settlement") resolveSettlementWaiter(commit.requestId);
      return;
    }
    if (commit.kind === "stream-frame") {
      // A running React commit cannot be replaced, but every not-yet-painted
      // prefix for the same request can. Keep ordering for loads/settlement and
      // publish the newest model state on the next available animation frame.
      visibleStreamQueueRef.current = visibleStreamQueueRef.current.filter((queued) => (
        queued.kind !== "stream-frame" || queued.requestId !== commit.requestId
      ));
    }
    visibleStreamQueueRef.current.push(commit);
    scheduleVisibleStreamCommit();
  }

  function scheduleVisibleStreamCommit(): void {
    if (visibleStreamFrameRef.current !== null || visibleStreamCommitRef.current) return;
    if (isVisualCommitSuspended()) return;
    visibleStreamFrameRef.current = window.requestAnimationFrame(runVisibleStreamCommit);
  }

  function runVisibleStreamCommit(): void {
    visibleStreamFrameRef.current = null;
    if (visibleStreamCommitRef.current) return;
    const next = visibleStreamQueueRef.current[0];
    if (!next) return;
    if (next.generation !== visibleStreamGenerationRef.current || activeThreadIdRef.current !== next.threadId) {
      visibleStreamQueueRef.current.shift();
      if (next.kind === "settlement") resolveSettlementWaiter(next.requestId);
      scheduleVisibleStreamCommit();
      return;
    }
    visibleStreamQueueRef.current.shift();
    visibleStreamCommitRef.current = next;
    if (next.kind === "stream-frame") {
      visibleStreamSnapshotsRef.current.set(next.requestId, next.liveMessages);
      applyVisibleStreamMessages(next.requestId, next.threadId, next.liveMessages, next.generation);
      return;
    }
    if (next.kind === "loaded-messages") {
      const shouldStick = shouldAutoFollow(next.threadId);
      const lockedScrollTop = shouldStick ? null : currentLockedScrollTop(next.threadId);
      const readingAnchor = shouldStick ? null : captureVisibleTimelineAnchor();
      // A promoted/delayed page can prepend a large historical baseline after
      // the live tail has already painted. Browser scroll anchoring is disabled
      // for the chat viewport, so preserve the first visible message in the
      // same pre-paint mutation turn before the bounded follower resumes.
      // Freeze the existing follower before capturing the prepend anchor. A
      // large historical page can render concurrently across several frames;
      // allowing an old animation or queued scroll action to keep advancing in
      // that window makes the commit boundary depend on renderer speed. The
      // messages layout effect restores this anchor first, then resumes the
      // bounded follower from the compensated position.
      if (shouldStick) stopTailFollowerForPrepend();
      const prependAnchor = shouldStick
        ? captureFirstVisibleMessageAnchor(messageScrollRef.current)
        : null;
      if (readingAnchor) prepareTimelineAnchorRestore(next.threadId, readingAnchor);
      if (prependAnchor) prepareMessageAnchorRestore(next.threadId, prependAnchor);
      setMessages((current) => {
        if (next.generation !== visibleStreamGenerationRef.current
          || activeThreadIdRef.current !== next.threadId) return current;
        // messagesForLoadedThread includes the newest authoritative live
        // snapshot. It may be ahead of what has actually painted, so use the
        // load only for its historical baseline and retain the displayed live
        // rows. The next animation-frame snapshot then converges to latest.
        const loadedBaseline = next.requestId
          ? next.messages.filter((message) => !isLiveMessageForRequest(message, next.requestId!))
          : next.messages;
        const visibleLive = next.requestId
          ? current.filter((message) => isLiveMessageForRequest(message, next.requestId!))
          : [];
        return reconcileRenderedMessages(current, [...loadedBaseline, ...visibleLive]);
      });
      if (!shouldStick) restoreScrollSoon(next.threadId, lockedScrollTop, readingAnchor);
      return;
    }
    applyVisibleStreamSettlement(next);
  }

  function applyVisibleStreamMessages(
    requestId: string,
    threadId: string,
    liveMessages: ChatStreamMessage[],
    generation: number
  ): void {
    const shouldStick = shouldAutoFollow(threadId);
    const lockedScrollTop = shouldStick ? null : currentLockedScrollTop(threadId);
    setMessages((current) => {
      if (generation !== visibleStreamGenerationRef.current || activeThreadIdRef.current !== threadId) return current;
      const modelId = threadRunModelsRef.current[threadId];
      const baseCreatedAt = Date.now();
      const head = current.filter((message) => !isLiveMessageForRequest(message, requestId));
      const previousLive = new Map(
        current
          .filter((message) => isLiveMessageForRequest(message, requestId))
          .map((message) => [message.id, message] as const)
      );
      const live = liveMessages.map<ChatMessage>((message, index) => {
        const id = chatStreamRenderId(requestId, index);
        const next: ChatMessage = {
          id,
          threadId,
          role: message.role,
          content: message.content,
          attachments: message.attachments ?? [],
          timeline: message.timeline,
          createdAt: new Date(baseCreatedAt + index).toISOString(),
          status: "sent",
          modelId: message.role === "assistant" ? modelId : undefined
        };
        const previous = previousLive.get(id);
        return previous && sameLiveMessage(previous, next) ? previous : next;
      });
      return [...head, ...live];
    });
    if (shouldStick) scrollSoon();
    else restoreScrollSoon(threadId, lockedScrollTop);
  }

  function applyVisibleStreamSettlement(commit: Extract<VisibleStreamCommit, { kind: "settlement" }>): void {
    const shouldStick = shouldAutoFollow(commit.threadId);
    const lockedScrollTop = shouldStick ? null : currentLockedScrollTop(commit.threadId);
    const readingAnchor = shouldStick ? null : captureVisibleTimelineAnchor();
    if (readingAnchor) prepareTimelineAnchorRestore(commit.threadId, readingAnchor);
    setMessages((current) => commit.generation === visibleStreamGenerationRef.current
      && activeThreadIdRef.current === commit.threadId
      ? applyChatStreamSettlement(current, commit.settlement)
      : current);
    if (shouldStick) scrollSoon();
    else restoreScrollSoon(commit.threadId, lockedScrollTop, readingAnchor);
  }

  function isVisualCommitSuspended(): boolean {
    return document.visibilityState === "hidden";
  }

  function finishVisibleStreamCommit(): void {
    const committed = visibleStreamCommitRef.current;
    if (!committed) return;
    visibleStreamCommitRef.current = null;
    if (committed.kind === "settlement") {
      visibleStreamSnapshotsRef.current.delete(committed.requestId);
      visibleStreamQueuedSnapshotsRef.current.delete(committed.requestId);
      resolveSettlementWaiter(committed.requestId);
    }
    scheduleVisibleStreamCommit();
  }

  function discardVisibleStreamCommits(): void {
    visibleStreamGenerationRef.current += 1;
    // A pending prepend anchor belongs to the visual generation being
    // discarded. Keeping it across navigation, reset, or a hidden-window
    // convergence can make a later unrelated message commit replay stale
    // geometry and jump the viewport.
    pendingMessageAnchorRestoreRef.current = null;
    if (visibleStreamFrameRef.current !== null) {
      window.cancelAnimationFrame(visibleStreamFrameRef.current);
      visibleStreamFrameRef.current = null;
    }
    const discarded = [visibleStreamCommitRef.current, ...visibleStreamQueueRef.current];
    visibleStreamCommitRef.current = null;
    visibleStreamQueueRef.current = [];
    visibleStreamSnapshotsRef.current.clear();
    visibleStreamQueuedSnapshotsRef.current.clear();
    for (const commit of discarded) {
      if (commit?.kind === "settlement") resolveSettlementWaiter(commit.requestId);
    }
  }

  function discardVisibleStreamCommitsForRequest(requestId: string): void {
    const current = visibleStreamCommitRef.current;
    if (current && "requestId" in current && current.requestId === requestId) {
      // A state updater may already have been scheduled. Invalidate the whole
      // visual generation so that updater cannot land after the terminal load.
      discardVisibleStreamCommits();
      return;
    }
    const discarded = visibleStreamQueueRef.current.filter((commit) => (
      "requestId" in commit && commit.requestId === requestId
    ));
    visibleStreamQueueRef.current = visibleStreamQueueRef.current.filter((commit) => !(
      "requestId" in commit && commit.requestId === requestId
    ));
    visibleStreamSnapshotsRef.current.delete(requestId);
    visibleStreamQueuedSnapshotsRef.current.delete(requestId);
    for (const commit of discarded) {
      if (commit.kind === "settlement") resolveSettlementWaiter(commit.requestId);
    }
    if (visibleStreamQueueRef.current.length === 0 && visibleStreamCommitRef.current === null
      && visibleStreamFrameRef.current !== null) {
      window.cancelAnimationFrame(visibleStreamFrameRef.current);
      visibleStreamFrameRef.current = null;
    }
  }

  function resolveSettlementWaiter(requestId: string): void {
    settlementWaitersRef.current.get(requestId)?.();
    settlementWaitersRef.current.delete(requestId);
  }

  function jumpToTailSoon() {
    scheduleScrollAdjust(() => {
      const scroll = messageScrollRef.current;
      if (!scroll) return;
      stopTailScrollAnimation();
      writeScrollTop(scroll, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
    }, 1);
  }

  function applyStreamSettlement(event: ChatStreamEvent) {
    if (!event.settlement) return;
    liveStreamSnapshotsRef.current.delete(event.requestId);
    visibleStreamQueuedSnapshotsRef.current.delete(event.requestId);
    const pendingLoad = pendingInitialLoadsRef.current.get(event.threadId);
    if (pendingLoad?.promotedRequestId !== event.requestId) {
      runLoadBoundariesRef.current.delete(event.requestId);
    }
    settledRequestIdsRef.current.add(event.requestId);
    settledRequestStatusesRef.current.set(event.requestId, event.status);
    if (activeThreadIdRef.current !== event.threadId || isVisualCommitSuspended()) {
      latestSettlementsByThreadRef.current.set(event.threadId, {
        requestId: event.requestId,
        settlement: event.settlement
      });
      discardVisibleStreamCommitsForRequest(event.requestId);
      // Hidden windows have no intermediate paint to preserve. Commit the
      // database-backed terminal state immediately so a paused rAF cannot keep
      // the request running forever; navigation will reconcile from the same
      // canonical settlement if this thread is offscreen.
      if (activeThreadIdRef.current === event.threadId) {
        applyTerminalSettlementNow(event.threadId, event.settlement);
      }
      resolveSettlementWaiter(event.requestId);
      return;
    }
    latestSettlementsByThreadRef.current.set(event.threadId, {
      requestId: event.requestId,
      settlement: event.settlement
    });
    enqueueVisibleStreamCommit({
      kind: "settlement",
      requestId: event.requestId,
      threadId: event.threadId,
      settlement: event.settlement
    });
  }

  function applyTerminalSettlementNow(
    threadId: string,
    canonicalSettlement: ChatStreamSettlement
  ): void {
    const shouldStick = shouldAutoFollow(threadId);
    const lockedScrollTop = shouldStick ? null : currentLockedScrollTop(threadId);
    const readingAnchor = shouldStick ? null : captureVisibleTimelineAnchor();
    if (readingAnchor) prepareTimelineAnchorRestore(threadId, readingAnchor);
    setMessages((current) => applyChatStreamSettlement(current, canonicalSettlement));
    if (shouldStick) scrollSoon();
    else restoreScrollSoon(threadId, lockedScrollTop, readingAnchor);
  }

  function waitForSettlement(requestId: string): Promise<void> {
    return new Promise((resolve) => settlementWaitersRef.current.set(requestId, resolve));
  }

  async function awaitSettlementOrTimeout(requestId: string, settlement: Promise<void>): Promise<void> {
    const timedOut = await Promise.race([
      settlement.then(() => false),
      new Promise<true>((resolve) => window.setTimeout(() => resolve(true), 250))
    ]);
    // A received settlement can be intentionally waiting behind visible stream
    // snapshots. Do not clear request state underneath that queue; only use the
    // timeout as a fallback for providers that never emitted a settlement.
    if (timedOut && settledRequestIdsRef.current.has(requestId)) await settlement;
  }

  async function finishAbortedRequest(threadId: string, requestId: string): Promise<void> {
    setThreadError(threadId, null);
    setThreadRunState(threadId, "idle");
    clearThreadQueue(threadId);
    clearThreadRequestId(threadId);
    clearThreadRunModel(threadId);
    await options.refreshThreads(activeThreadIdRef.current === threadId ? threadId : null).catch(() => undefined);
    clearSettledRequest(requestId);
  }

  function clearSettledRequest(requestId: string): void {
    settlementWaitersRef.current.delete(requestId);
    settledRequestIdsRef.current.delete(requestId);
    settledRequestStatusesRef.current.delete(requestId);
    if (![...pendingInitialLoadsRef.current.values()].some((load) => load.promotedRequestId === requestId)) {
      runLoadBoundariesRef.current.delete(requestId);
    }
  }

  function restoreScrollSoon(
    threadId: string,
    scrollTop: number | null,
    anchor: { itemId: string; viewportTop: number } | null = null
  ) {
    if (scrollTop === null) return;
    scheduleScrollAdjust(() => {
      if (activeThreadIdRef.current !== threadId || shouldAutoFollow(threadId)) return;
      const scroll = messageScrollRef.current;
      if (scroll) {
        stopTailScrollAnimation();
        // A wheel, pointer, keyboard, or scrollbar gesture can move again after
        // this restore was queued. Read the latest explicit reading position at
        // execution time instead of replaying the stale captured coordinate.
        writeScrollTop(scroll, lockedScrollTopRef.current[threadId] ?? scrollTop);
        // React has committed the settlement before this scheduled rAF. Apply
        // the anchor correction in the same frame as the absolute restore so a
        // displaced reading row is never painted for one intermediate frame.
        if (anchor) restoreTimelineAnchor(threadId, anchor);
      }
    });
  }

  function captureVisibleTimelineAnchor(): { itemId: string; viewportTop: number } | null {
    const scroll = messageScrollRef.current;
    if (!scroll) return null;
    const scrollRect = scroll.getBoundingClientRect();
    const candidates = Array.from(scroll.querySelectorAll<HTMLElement>("[data-timeline-item-id]:not([hidden])"));
    const target = candidates.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > scrollRect.top && rect.top < scrollRect.bottom;
    });
    if (!target) return null;
    return {
      itemId: target.dataset.timelineItemId ?? "",
      viewportTop: target.getBoundingClientRect().top - scrollRect.top
    };
  }

  function prepareTimelineAnchorRestore(threadId: string, anchor: { itemId: string; viewportTop: number }): void {
    const scroll = messageScrollRef.current;
    if (!scroll) return;
    const root = scroll.querySelector<HTMLElement>(".message-stack");
    if (!root) return;
    const observer = new MutationObserver(() => {
      observer.disconnect();
      if (activeThreadIdRef.current !== threadId || shouldAutoFollow(threadId)) return;
      // MutationObserver runs after React commits but before the browser paints,
      // so compensating here avoids the one-frame settlement jump that a second
      // requestAnimationFrame would expose to the reader.
      restoreTimelineAnchor(threadId, anchor);
    });
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "data-message-id"]
    });
    window.setTimeout(() => observer.disconnect(), 250);
  }

  function captureFirstVisibleMessageAnchor(scroll: HTMLDivElement | null): MessageContentAnchor | null {
    if (!scroll) return null;
    const scrollRect = scroll.getBoundingClientRect();
    const target = Array.from(scroll.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((candidate) => candidate.getBoundingClientRect().bottom > scrollRect.top);
    return target ? {
      messageId: target.dataset.messageId ?? "",
      // Content-space position stays stable while a concurrent large-page render
      // yields and the tail follower advances scrollTop across painted frames.
      contentTop: target.getBoundingClientRect().top - scrollRect.top + scroll.scrollTop
    } : null;
  }

  function prepareMessageAnchorRestore(threadId: string, anchor: MessageContentAnchor): void {
    // Consume this from the messages layout effect after React commits the
    // prepend but before that commit is painted. Unlike a timer-bound observer,
    // this remains correct when a large Markdown page takes longer than 250ms
    // to render on a constrained machine.
    pendingMessageAnchorRestoreRef.current = {
      threadId,
      anchor
    };
  }

  function restoreMessageAnchor(threadId: string, anchor: MessageContentAnchor | null): void {
    if (!anchor || activeThreadIdRef.current !== threadId) return;
    const scroll = messageScrollRef.current;
    if (!scroll) return;
    const target = scroll.querySelector<HTMLElement>(`[data-message-id="${cssEscapeSelector(anchor.messageId)}"]`);
    if (!target) return;
    const nextContentTop = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    const delta = nextContentTop - anchor.contentTop;
    if (Math.abs(delta) > 0.5) writeScrollTop(scroll, scroll.scrollTop + delta);
  }

  function restoreTimelineAnchor(threadId: string, anchor: { itemId: string; viewportTop: number }): void {
    if (activeThreadIdRef.current !== threadId || shouldAutoFollow(threadId) || !anchor.itemId) return;
    const scroll = messageScrollRef.current;
    if (!scroll) return;
    const target = Array.from(scroll.querySelectorAll<HTMLElement>("[data-timeline-item-id]"))
      .find((candidate) => candidate.dataset.timelineItemId === anchor.itemId && !candidate.hidden);
    if (!target) return;
    const delta = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.viewportTop;
    if (Math.abs(delta) <= 0.5) return;
    writeScrollTop(scroll, scroll.scrollTop + delta);
    lockedScrollTopRef.current[threadId] = scroll.scrollTop;
  }

  function animateScrollToTail(scroll: HTMLDivElement) {
    if (tailScrollAnimationRef.current !== null) return;
    const tick = () => {
      tailScrollAnimationRef.current = null;
      const threadId = activeThreadIdRef.current;
      if (!threadId || !shouldAutoFollow(threadId) || messageScrollRef.current !== scroll) return;
      const target = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const distance = target - scroll.scrollTop;
      if (distance <= 1) {
        writeScrollTop(scroll, target);
        return;
      }
      const liveAssistants = scroll.querySelectorAll<HTMLElement>(".assistant-block.live-message");
      const activeTail = liveAssistants.item(liveAssistants.length - 1);
      const viewportBottom = scroll.getBoundingClientRect().bottom;
      const visualTailOffset = activeTail
        ? Math.max(0, activeTail.getBoundingClientRect().bottom - viewportBottom)
        : distance;
      // Use the full smooth-frame budget while content is still arriving. A
      // proportional 6-15px step can fall behind when a low-rate paint contains
      // more than one wrapped line, even though every individual scroll write
      // remains small. The 16px cap preserves the no-staircase contract while
      // consuming each painted frame's available follow budget.
      const step = activeTail && visualTailOffset > 0 ? 16 : Math.min(16, Math.max(6, visualTailOffset * 0.55));
      writeScrollTop(scroll, scroll.scrollTop + Math.min(distance, step));
      tailScrollAnimationRef.current = window.requestAnimationFrame(tick);
    };
    tailScrollAnimationRef.current = window.requestAnimationFrame(tick);
  }

  function snapCoalescedTailBeforePaint(scroll: HTMLDivElement): void {
    const liveAssistants = scroll.querySelectorAll<HTMLElement>(".assistant-block.live-message");
    const activeTail = liveAssistants.item(liveAssistants.length - 1);
    if (!activeTail) return;
    const visualTailOffset = Math.max(
      0,
      activeTail.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom
    );
    if (visualTailOffset <= COALESCED_TAIL_SNAP_THRESHOLD_PX) return;
    writeScrollTop(scroll, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
  }

  function stopTailScrollAnimation() {
    if (tailScrollAnimationRef.current === null) return;
    window.cancelAnimationFrame(tailScrollAnimationRef.current);
    tailScrollAnimationRef.current = null;
  }

  function stopTailFollowerForPrepend() {
    const pending = pendingScrollActionRef.current;
    pendingScrollActionRef.current = null;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    // Preserve an explicit same-frame End intent while discarding the ordinary
    // priority-0 follower that would otherwise move during the large render.
    // Applying End against the old DOM before anchor capture makes that chosen
    // tail position the stable baseline for the prepend compensation.
    if (pending && pending.priority > 0) pending.apply();
    stopTailScrollAnimation();
  }

  function writeScrollTop(scroll: HTMLDivElement, value: number) {
    const generation = ++programmaticScrollGenerationRef.current;
    programmaticScrollRef.current = true;
    scroll.scrollTop = value;
    lastObservedScrollTopRef.current = scroll.scrollTop;
    lastObservedScrollHeightRef.current = scroll.scrollHeight;
    window.requestAnimationFrame(() => {
      if (programmaticScrollGenerationRef.current !== generation) return;
      programmaticScrollRef.current = false;
      lastObservedScrollTopRef.current = scroll.scrollTop;
      lastObservedScrollHeightRef.current = scroll.scrollHeight;
    });
  }

  // Coalesce the many auto-follow scroll writes that arrive during streaming into a
  // single layout write per animation frame, so a fast stream cannot trigger a
  // read/write layout thrash loop on every ~45ms chunk.
  function scheduleScrollAdjust(apply: () => void, priority = 0) {
    const pending = pendingScrollActionRef.current;
    if (!pending || priority >= pending.priority) pendingScrollActionRef.current = { apply, priority };
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const action = pendingScrollActionRef.current;
      pendingScrollActionRef.current = null;
      action?.apply();
    });
  }

  function currentLockedScrollTop(threadId: string): number | null {
    const scroll = messageScrollRef.current;
    return lockedScrollTopRef.current[threadId] ?? scroll?.scrollTop ?? null;
  }

  function shouldAutoFollow(threadId: string): boolean {
    return !autoFollowLockedThreadIdsRef.current.has(threadId);
  }

  function onMessageWheel(deltaY: number) {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    if (deltaY < 0) lockAutoFollow(threadId);
  }

  function onMessageInteraction() {
    const threadId = activeThreadIdRef.current;
    if (threadId) lockAutoFollow(threadId);
  }

  function onMessageTailIntent() {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    unlockAutoFollow(threadId);
    jumpToTailSoon();
  }

  function onMessageScroll() {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    const scroll = messageScrollRef.current;
    if (!scroll) return;
    const distanceFromBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    const movedUp = scroll.scrollTop < lastObservedScrollTopRef.current - 1;
    const layoutChanged = Math.abs(scroll.scrollHeight - lastObservedScrollHeightRef.current) > 1;
    const wasLocked = autoFollowLockedThreadIdsRef.current.has(threadId);
    const previousLockedTop = lockedScrollTopRef.current[threadId] ?? scroll.scrollTop;
    const explicitlyMovedToTail = !programmaticScrollRef.current
      && scroll.scrollTop > previousLockedTop + 1
      && distanceFromBottom <= 24;
    if (wasLocked) {
      // A gutter press or drag can lock while the viewport is still at the tail.
      // Scroll events queued by the previous follower must not interpret that
      // near-tail geometry as fresh user intent and immediately undo the lock.
      // Re-enable geometry-based following only after a real downward movement
      // reaches the tail; End remains the explicit, race-free recovery path.
      if (explicitlyMovedToTail) unlockAutoFollow(threadId);
      else lockedScrollTopRef.current[threadId] = scroll.scrollTop;
    } else if (!programmaticScrollRef.current && movedUp && !layoutChanged && distanceFromBottom > 24) {
      lockAutoFollow(threadId);
    } else if (distanceFromBottom <= 24) {
      unlockAutoFollow(threadId);
    }
    lastObservedScrollTopRef.current = scroll.scrollTop;
    lastObservedScrollHeightRef.current = scroll.scrollHeight;
  }

  function lockAutoFollow(threadId: string) {
    stopTailScrollAnimation();
    // An already queued restore/follow action was calculated before this
    // explicit reading gesture and must not run later in the same frame.
    pendingScrollActionRef.current = null;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    autoFollowLockedThreadIdsRef.current.add(threadId);
    const scroll = messageScrollRef.current;
    if (scroll) lockedScrollTopRef.current[threadId] = scroll.scrollTop;
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
      if (requestId) {
        liveStreamSnapshotsRef.current.delete(requestId);
        settlementWaitersRef.current.delete(requestId);
        settledRequestIdsRef.current.delete(requestId);
        settledRequestStatusesRef.current.delete(requestId);
        runLoadBoundariesRef.current.delete(requestId);
      }
      latestSettlementsByThreadRef.current.delete(threadId);
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
    onMessageInteraction,
    onMessageTailIntent,
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

function messagesForRetry(current: ChatMessage[], messageId?: string): ChatMessage[] {
  if (messageId) {
    const retryIndex = current.findIndex((message) => message.id === messageId);
    if (retryIndex < 0) return current;
    return current.slice(0, current[retryIndex]?.role === "user" ? retryIndex + 1 : retryIndex);
  }
  const next = [...current];
  while (next.at(-1)?.role === "assistant") next.pop();
  return next;
}

function messagesForEdit(
  current: ChatMessage[],
  messageId: string,
  content: string,
  attachments: PickedPath[],
  skillsUsed: SkillReference[],
  pluginsUsed: PluginReference[]
): ChatMessage[] {
  const targetIndex = current.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) return current;
  const next = current.slice(0, targetIndex + 1);
  next[targetIndex] = {
    ...next[targetIndex],
    content: content.trim(),
    attachments,
    skillsUsed,
    pluginsUsed
  };
  return next;
}

function lastStableMessageId(messages: ChatMessage[]): string | undefined {
  return [...messages].reverse().find((message) => (
    !message.id.startsWith("pending-") && !message.id.startsWith("stream-") && !message.id.startsWith("error-")
  ))?.id;
}

function applyRunLoadBoundary(persisted: ChatMessage[], boundary: RunLoadBoundary): ChatMessage[] {
  if (!boundary.replaceAfterMessageId) {
    if (!boundary.appendPersistedWhenUnanchored) return boundary.prefix;
    // The main process may already have persisted the optimistic user before an
    // initial list request returns. The two rows have different ids, so id-only
    // merging would paint the same prompt twice until settlement. Treat the
    // pending prefix as authoritative for its matching persisted user tail.
    const optimisticUsers = boundary.prefix.filter((message) => message.id.startsWith("pending-") && message.role === "user");
    const persistedWithoutOptimisticDuplicates = [...persisted];
    // Only the newest matching persisted user can be this run's just-written
    // optimistic prefix. Older identical prompts are legitimate history.
    for (const optimistic of optimisticUsers) {
      for (let index = persistedWithoutOptimisticDuplicates.length - 1; index >= 0; index -= 1) {
        const message = persistedWithoutOptimisticDuplicates[index];
        if (message.role !== "user") continue;
        const optimisticCreatedAt = Date.parse(optimistic.createdAt);
        const persistedCreatedAt = Date.parse(message.createdAt);
        if (message.content === optimistic.content
          && Number.isFinite(optimisticCreatedAt)
          && Number.isFinite(persistedCreatedAt)
          && persistedCreatedAt >= optimisticCreatedAt
          && sameAttachments(message.attachments ?? [], optimistic.attachments ?? [])) {
          persistedWithoutOptimisticDuplicates.splice(index, 1);
        }
        break;
      }
    }
    return mergeMessages(persistedWithoutOptimisticDuplicates, boundary.prefix);
  }
  const anchorIndex = persisted.findIndex((message) => message.id === boundary.replaceAfterMessageId);
  if (anchorIndex < 0) return boundary.prefix;
  return [...persisted.slice(0, anchorIndex + 1), ...boundary.prefix];
}

function toLiveChatMessages(
  requestId: string,
  threadId: string,
  liveSnapshot: ChatStreamMessage[],
  modelId?: string
): ChatMessage[] {
  const baseCreatedAt = Date.now();
  return liveSnapshot.map((message, index) => ({
    id: chatStreamRenderId(requestId, index),
    threadId,
    role: message.role,
    content: message.content,
    attachments: message.attachments ?? [],
    timeline: message.timeline,
    createdAt: new Date(baseCreatedAt + index).toISOString(),
    status: "sent",
    modelId: message.role === "assistant" ? modelId : undefined
  }));
}

function isBusy(state: RunState | undefined): boolean {
  return state === "running" || state === "stopping";
}

const EMPTY_QUEUE_STATE: ChatQueueState = { followUp: [], steering: [] };

function isLiveMessageForRequest(message: ChatMessage, requestId: string): boolean {
  const prefix = `stream-${requestId}-`;
  return message.id === `stream-${requestId}`
    || message.id.startsWith(prefix)
    || message.renderId === `stream-${requestId}`
    || message.renderId?.startsWith(prefix) === true;
}

function isStagedMessageForRequest(message: ChatMessage, requestId: string): boolean {
  const pendingPrefix = `pending-${requestId}-`;
  return isLiveMessageForRequest(message, requestId)
    || message.id.startsWith(pendingPrefix)
    || message.renderId?.startsWith(pendingPrefix) === true;
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

function reconcileRenderedMessages(currentMessages: ChatMessage[], persistedMessages: ChatMessage[]): ChatMessage[] {
  const currentById = new Map(currentMessages.map((message) => [message.id, message] as const));
  const currentByRenderId = new Map(currentMessages.flatMap((message) => (
    message.renderId ? [[message.renderId, message] as const] : []
  )));
  return persistedMessages.map((message) => {
    const current = currentById.get(message.id)
      ?? (message.renderId ? currentByRenderId.get(message.renderId) : undefined);
    if (!current) return message;
    const next = current.renderId && !message.renderId
      ? { ...message, renderId: current.renderId }
      : message;
    return sameRenderedMessage(current, next) ? current : next;
  });
}

function carryFailedSendRenderIdentity(
  persistedMessages: ChatMessage[],
  currentMessages: ChatMessage[],
  requestId: string,
  existingMessageIds: ReadonlySet<string>
): ChatMessage[] {
  const pendingRenderId = chatStreamPrefixRenderId(requestId, 0);
  const optimisticUser = currentMessages.find((message) => (
    message.role === "user"
    && (message.id === pendingRenderId || message.renderId === pendingRenderId)
  ));
  if (!optimisticUser) return persistedMessages;
  const persistedUser = [...persistedMessages].reverse().find((message) => (
    message.role === "user"
    && !existingMessageIds.has(message.id)
    && message.content === optimisticUser.content
    && sameAttachments(message.attachments ?? [], optimisticUser.attachments ?? [])
  ));
  if (!persistedUser || persistedUser.renderId) return persistedMessages;
  return persistedMessages.map((message) => message === persistedUser
    ? { ...message, renderId: pendingRenderId }
    : message);
}

function mergeFailedRunPage(
  currentMessages: ChatMessage[],
  persistedPage: ChatMessage[],
  boundary?: RunLoadBoundary
): ChatMessage[] {
  const anchorId = boundary?.replaceAfterMessageId;
  if (!anchorId) return persistedPage;
  const currentAnchorIndex = currentMessages.findIndex((message) => message.id === anchorId);
  if (currentAnchorIndex < 0) return persistedPage;
  const stablePrefix = currentMessages.slice(0, currentAnchorIndex + 1);
  const persistedAnchorIndex = persistedPage.findIndex((message) => message.id === anchorId);
  // Normally the latest page still contains the run anchor. If a very large
  // externally-written tail pushed it out, merge by id so the already-loaded
  // prefix remains authoritative while genuinely newer persisted rows append.
  const authoritativeTail = persistedAnchorIndex >= 0
    ? persistedPage.slice(persistedAnchorIndex + 1)
    : persistedPage;
  return mergeMessages(stablePrefix, authoritativeTail);
}

function sameRenderedMessage(previous: ChatMessage, next: ChatMessage): boolean {
  return previous.id === next.id
    && previous.renderId === next.renderId
    && previous.threadId === next.threadId
    && previous.runId === next.runId
    && previous.role === next.role
    && previous.content === next.content
    && previous.createdAt === next.createdAt
    && previous.elapsedMs === next.elapsedMs
    && previous.modelId === next.modelId
    && previous.status === next.status
    && sameAttachments(previous.attachments ?? [], next.attachments ?? [])
    && sameTimeline(previous.timeline ?? [], next.timeline ?? []);
}

function withTransientErrorFallback(
  persistedMessages: ChatMessage[] | null,
  fallbackMessages: ChatMessage[],
  existingMessageIds: ReadonlySet<string>,
  transientError: ChatMessage
): ChatMessage[] {
  const base = persistedMessages ?? fallbackMessages;
  const persistedFailure = persistedMessages?.some((message) => (
    !existingMessageIds.has(message.id) && message.role === "assistant" && message.status === "error"
  ));
  return persistedFailure ? base : [...base, transientError];
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
        previous.toolCallId === next.toolCallId &&
        previous.toolName === next.toolName &&
        previous.title === next.title &&
        previous.argumentsJson === next.argumentsJson
      );
    case "tool_result":
      return (
        next.kind === "tool_result" &&
        previous.toolCallId === next.toolCallId &&
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

function cssEscapeSelector(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
