import { useEffect, useState } from "react";
import type { MemoryCreateRequest, MemoryRecord } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

export function useMemories(options: {
  open: boolean;
  onError(message: string | null): void;
  onToast(message: string): void;
}) {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (options.open) void refresh();
  }, [options.open]);

  async function refresh() {
    setLoading(true);
    try {
      setMemories(await getBridge().listMemories({ includeArchived: true }));
      options.onError(null);
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to load memories."));
    } finally {
      setLoading(false);
    }
  }

  async function createMemory(request: MemoryCreateRequest) {
    try {
      const memory = await getBridge().createMemory(request);
      setMemories((current) => [memory, ...current]);
      options.onToast("Memory saved");
      return memory;
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to save memory."));
      return null;
    }
  }

  async function updateMemory(id: string, content: string) {
    try {
      const memory = await getBridge().updateMemory({ id, content });
      setMemories((current) => current.map((item) => item.id === id ? memory : item));
      options.onToast("Memory updated");
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to update memory."));
    }
  }

  async function archiveMemory(id: string, archived: boolean) {
    try {
      const memory = await getBridge().archiveMemory({ id, archived });
      setMemories((current) => current.map((item) => item.id === id ? memory : item));
      options.onToast(archived ? "Memory archived" : "Memory restored");
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to archive memory."));
    }
  }

  async function deleteMemory(id: string) {
    try {
      await getBridge().deleteMemory(id);
      setMemories((current) => current.filter((item) => item.id !== id));
      options.onToast("Memory deleted");
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to delete memory."));
    }
  }

  return {
    memories,
    activeMemories: memories.filter((memory) => !memory.archived && !memory.deleted),
    loading,
    refresh,
    createMemory,
    updateMemory,
    archiveMemory,
    deleteMemory
  };
}
