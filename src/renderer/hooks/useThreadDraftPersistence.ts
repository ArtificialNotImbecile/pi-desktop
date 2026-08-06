import { useEffect, useRef } from "react";
import type { ChatMessage } from "../../shared/ipc";
import { getBridge } from "../desktopApi";

export function useThreadDraftPersistence(input: {
  threadId: string | null;
  draft: string;
  editingMessage: ChatMessage | null;
  setDraft(value: string): void;
}) {
  const draftHydrationRef = useRef<{ threadId: string | null; loading: boolean }>({ threadId: null, loading: false });
  const draftValueRef = useRef("");

  useEffect(() => {
    draftValueRef.current = input.draft;
  }, [input.draft]);

  useEffect(() => {
    const threadId = input.threadId;
    if (!threadId) return;

    let cancelled = false;
    const draftAtRequestStart = draftValueRef.current;
    draftHydrationRef.current = { threadId, loading: true };
    void getBridge().getThreadDraft(threadId)
      .then((draft) => {
        if (cancelled || draftHydrationRef.current.threadId !== threadId) return;
        if (!input.editingMessage && draftValueRef.current === draftAtRequestStart) input.setDraft(draft);
      })
      .catch(() => undefined)
      .finally(() => {
        if (draftHydrationRef.current.threadId === threadId) draftHydrationRef.current.loading = false;
      });

    return () => {
      cancelled = true;
    };
  }, [input.threadId]);

  useEffect(() => {
    const threadId = input.threadId;
    if (!threadId || input.editingMessage || draftHydrationRef.current.loading) return;
    const handle = window.setTimeout(() => {
      void getBridge().updateThreadDraft({ threadId, content: input.draft }).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [input.threadId, input.draft, input.editingMessage]);
}
