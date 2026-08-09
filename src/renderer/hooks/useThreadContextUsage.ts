import { useEffect, useState } from "react";
import type { ThreadContextUsage } from "../../shared/ipc";
import type { RunState } from "../types";
import { getBridge } from "../desktopApi";

type StoredUsage = ThreadContextUsage & { key: string };

export function useThreadContextUsage(input: {
  threadId: string | null;
  providerId: string | null;
  modelId: string | null;
  fallbackContextWindow: number;
  refreshKey: string;
  runState: RunState;
}): ThreadContextUsage {
  const requestKey = `${input.threadId ?? ""}\u0000${input.providerId ?? ""}\u0000${input.modelId ?? ""}`;
  const [stored, setStored] = useState<StoredUsage | null>(null);

  useEffect(() => {
    if (!input.threadId || input.runState === "running" || input.runState === "stopping") return;
    let cancelled = false;
    void getBridge().getThreadContextUsage({
      threadId: input.threadId,
      providerId: input.providerId ?? undefined,
      modelId: input.modelId ?? undefined
    }).then((usage) => {
      if (!cancelled) setStored({ ...usage, key: requestKey });
    }).catch(() => {
      if (!cancelled) {
        setStored({
          key: requestKey,
          tokens: null,
          contextWindow: input.fallbackContextWindow,
          percent: null
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [input.threadId, input.providerId, input.modelId, input.fallbackContextWindow, input.refreshKey, input.runState, requestKey]);

  if (stored?.key === requestKey) return stored;
  return {
    tokens: null,
    contextWindow: input.fallbackContextWindow,
    percent: null
  };
}
