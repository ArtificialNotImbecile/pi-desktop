import { useEffect } from "react";
import { getBridge } from "../desktopApi";
import type { RightPanelMode } from "../navigation/routes";

export function useContextTaxonomyCapture(input: {
  threadId: string | null;
  activePanelMode: RightPanelMode | null;
  rightPanelCollapsed: boolean;
  chatPageRendered: boolean;
}): boolean {
  const threadId = input.threadId;
  const enabled = input.chatPageRendered
    && input.activePanelMode === "context"
    && !input.rightPanelCollapsed;

  useEffect(() => {
    if (!threadId) return;
    void getBridge().updateChatContextTaxonomyCapture({ threadId, enabled }).catch(() => undefined);
    return () => {
      void getBridge().updateChatContextTaxonomyCapture({ threadId, enabled: false }).catch(() => undefined);
    };
  }, [enabled, threadId]);

  return enabled;
}
