import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatThread } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

export function useThreads(options: { onError(message: string): void; onResetChatState(): void; onToast(message: string): void; onThreadsDeleted?(threadIds: string[]): void }) {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const activeThreadIdRef = useRef<string | null>(null);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threads]
  );

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  async function initialize() {
    try {
      const api = getBridge();
      let nextThreads = await api.listThreads();
      nextThreads = await compactEmptyThreads(nextThreads, options.onThreadsDeleted);
      if (nextThreads.length === 0) {
        const thread = await api.createThread({ title: "New chat" });
        nextThreads = [thread];
      }
      setThreads(nextThreads);
      setActiveThreadId(nextThreads[0]?.id ?? null);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to initialize Jasmine."));
    } finally {
      setLoadingThreads(false);
    }
  }

  // Applies a partial update to one thread in place. Used for cheap stream-time
  // updates (e.g. generated titles) so a running chat does not trigger a full
  // threads:list IPC round trip per event.
  function patchThread(threadId: string, partial: Partial<ChatThread>) {
    setThreads((current) => current.map((thread) => (thread.id === threadId ? { ...thread, ...partial } : thread)));
  }

  async function refreshThreads(preferredThreadId = activeThreadId) {
    const nextThreads = await compactEmptyThreads(await getBridge().listThreads(), options.onThreadsDeleted);
    setThreads(nextThreads);
    const targetThreadId = preferredThreadId === null ? activeThreadIdRef.current : preferredThreadId;
    if (targetThreadId && nextThreads.some((thread) => thread.id === targetThreadId)) {
      setActiveThreadId(targetThreadId);
    } else {
      setActiveThreadId(nextThreads[0]?.id ?? null);
    }
  }

  async function updateThreadActivePlugins(threadId: string, pluginIds: string[]): Promise<ChatThread | null> {
    try {
      const updated = await getBridge().updateThreadActivePlugins({ threadId, pluginIds });
      setThreads((current) => current.map((thread) => (thread.id === threadId ? updated : thread)));
      return updated;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to update active packages."));
      return null;
    }
  }

  async function startNewChat(forceNewThread = false, projectId: string | null = null): Promise<ChatThread | null> {
    try {
      const latestThreads = await compactEmptyThreads(await getBridge().listThreads(), options.onThreadsDeleted);
      const existingEmptyThread = latestThreads.find((thread) =>
        thread.projectId === projectId &&
        thread.messageCount === 0 &&
        !thread.draft &&
        (thread.activePluginIds?.length ?? 0) === 0 &&
        (!forceNewThread || thread.id !== activeThreadIdRef.current)
      );
      if (existingEmptyThread) {
        setThreads(latestThreads);
        setActiveThreadId(existingEmptyThread.id);
        options.onResetChatState();
        return existingEmptyThread;
      }

      const thread = await getBridge().createThread({ title: "New chat", projectId });
      setThreads([thread, ...latestThreads]);
      setActiveThreadId(thread.id);
      options.onResetChatState();
      return thread;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to create a new chat."));
      return null;
    }
  }

  async function renameThread(threadId: string, title: string): Promise<boolean> {
    try {
      const updated = await getBridge().renameThread({ id: threadId, title });
      setThreads((current) => current.map((thread) => (thread.id === threadId ? updated : thread)));
      options.onToast("Thread renamed");
      return true;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to rename thread."));
      return false;
    }
  }

  async function deleteSingleThread(threadId: string, fallbackProjectId: string | null = null): Promise<boolean> {
    try {
      await getBridge().deleteThread(threadId);
      options.onThreadsDeleted?.([threadId]);
      const nextThreads = await compactEmptyThreads(await getBridge().listThreads(), options.onThreadsDeleted);
      if (nextThreads.length === 0) {
        const thread = await getBridge().createThread({ title: "New chat", projectId: fallbackProjectId });
        setThreads([thread]);
        setActiveThreadId(thread.id);
      } else {
        setThreads(nextThreads);
        if (activeThreadIdRef.current === threadId) {
          setActiveThreadId(nextThreads[0]?.id ?? null);
          options.onResetChatState();
        }
      }
      options.onToast("Thread deleted");
      return true;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to delete thread."));
      return false;
    }
  }

  return {
    threads,
    activeThread,
    activeThreadId,
    loadingThreads,
    setActiveThreadId,
    refreshThreads,
    patchThread,
    updateThreadActivePlugins,
    startNewChat,
    renameThread,
    deleteSingleThread
  };
}

async function compactEmptyThreads(threads: ChatThread[], onThreadsDeleted?: (threadIds: string[]) => void): Promise<ChatThread[]> {
  const emptyThreadsByScope = new Map<string, ChatThread[]>();
  for (const thread of threads) {
    if (thread.messageCount > 0 || thread.draft) continue;
    if ((thread.activePluginIds?.length ?? 0) > 0) continue;
    const scopeKey = thread.projectId ?? "chats";
    emptyThreadsByScope.set(scopeKey, [...(emptyThreadsByScope.get(scopeKey) ?? []), thread]);
  }

  const deleteIds = new Set<string>();
  for (const emptyThreads of emptyThreadsByScope.values()) {
    if (emptyThreads.length <= 1) continue;
    for (const thread of emptyThreads.slice(1)) {
      deleteIds.add(thread.id);
    }
  }
  if (deleteIds.size === 0) return threads;
  await getBridge().deleteThreads(Array.from(deleteIds));
  onThreadsDeleted?.(Array.from(deleteIds));
  return threads.filter((thread) => !deleteIds.has(thread.id));
}
