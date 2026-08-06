import { useCallback, useEffect, useState } from "react";
import type { TodoAddRequest, TodoFileKind, TodoSnapshot } from "../../shared/ipc";
import { getBridge } from "../desktopApi";

export function useTodos(options: {
  enabled: boolean;
  messages: {
    loadFailed: string;
    saveFailed: string;
    saved: string;
    openFailed: string;
    opened: string;
  };
  onError(error: string | null): void;
  onToast(message: string): void;
}) {
  const { enabled, messages, onError, onToast } = options;
  const [snapshot, setSnapshot] = useState<TodoSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [openingKind, setOpeningKind] = useState<TodoFileKind | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getBridge().getTodoSnapshot();
      setSnapshot(next);
      onError(null);
      return next;
    } catch (error) {
      onError(error instanceof Error ? error.message : messages.loadFailed);
      return null;
    } finally {
      setLoading(false);
    }
  }, [messages.loadFailed, onError]);

  useEffect(() => {
    if (!enabled) return;
    if (snapshot || loading) return;
    void refresh();
  }, [enabled, loading, refresh, snapshot]);

  const addTodo = useCallback(async (request: TodoAddRequest) => {
    setSaving(true);
    try {
      const next = await getBridge().addTodo(request);
      setSnapshot(next);
      onError(null);
      onToast(messages.saved);
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : messages.saveFailed);
      return false;
    } finally {
      setSaving(false);
    }
  }, [messages.saveFailed, messages.saved, onError, onToast]);

  const openFile = useCallback(async (kind: TodoFileKind) => {
    setOpeningKind(kind);
    try {
      await getBridge().openTodoFile({ kind });
      onToast(messages.opened);
      onError(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : messages.openFailed);
    } finally {
      setOpeningKind(null);
    }
  }, [messages.openFailed, messages.opened, onError, onToast]);

  return {
    snapshot,
    loading,
    saving,
    openingKind,
    refresh,
    addTodo,
    openFile
  };
}
