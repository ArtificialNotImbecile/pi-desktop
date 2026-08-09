import { useEffect, useState } from "react";
import type { WorkingNavigationTarget, WorkingSnapshot } from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

const emptySnapshot: WorkingSnapshot = { items: [], activeCount: 0, attentionCount: 0 };

export function useWorkingTasks(options: {
  onError(message: string): void;
  onNavigate(target: WorkingNavigationTarget): void;
}) {
  const [snapshot, setSnapshot] = useState<WorkingSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const bridge = getBridge();
    const unsubscribeChanged = bridge.onWorkingChanged((next) => {
      if (!cancelled) setSnapshot(next);
    });
    const unsubscribeNavigate = bridge.onWorkingNavigate(options.onNavigate);
    void Promise.all([bridge.getWorkingSnapshot(), bridge.consumePendingWorkingNavigation()])
      .then(([next, pending]) => {
        if (cancelled) return;
        setSnapshot(next);
        if (pending) options.onNavigate(pending);
      })
      .catch((caught) => options.onError(errorMessage(caught, "Failed to load Working tasks.")))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribeChanged();
      unsubscribeNavigate();
    };
  }, []);

  async function markRead(requestId: string) {
    try {
      setSnapshot(await getBridge().markWorkingRead(requestId));
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to mark the Working task as read."));
    }
  }

  async function clearCompleted() {
    try {
      setSnapshot(await getBridge().clearCompletedWorking());
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to clear completed Working tasks."));
    }
  }

  async function stop(requestId: string) {
    try {
      if (!await getBridge().stopWorkingTask(requestId)) {
        options.onError("This task is no longer running.");
      }
    } catch (caught) {
      options.onError(errorMessage(caught, "Failed to stop the Working task."));
    }
  }

  return { snapshot, loading, markRead, clearCompleted, stop };
}
