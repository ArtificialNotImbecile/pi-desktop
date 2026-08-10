import { useEffect, useRef } from "react";
import { getBridge } from "../desktopApi";
import type { SpotlightExecuteRequest } from "../../shared/ipc";

export type SpotlightCommandHandlers = {
  openThread(threadId: string, projectId?: string | null): void;
  newChat(): void;
  openSettings(section?: string): void;
};

export function useSpotlightCommandBridge(handlers: SpotlightCommandHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const dispatch = (payload: SpotlightExecuteRequest) => {
      const current = handlersRef.current;
      if (payload.commandId === "open-thread" && payload.threadId) {
        current.openThread(payload.threadId, payload.projectId ?? null);
      } else if (payload.commandId === "new-chat") {
        current.newChat();
      } else if (payload.commandId === "open-settings") {
        current.openSettings(payload.section);
      }
    };

    const off = getBridge().onSpotlightCommand(dispatch);

    // When the main window was rebuilt from the tray or a relaunch, the command
    // that triggered the rebuild is queued in the main process. Pull it once the
    // bridge has mounted so the command is never lost to a load/listener race.
    let cancelled = false;
    void getBridge()
      .spotlightConsumePending()
      .then((pending) => {
        if (!cancelled && pending) dispatch(pending);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      off();
    };
  }, []);
}
