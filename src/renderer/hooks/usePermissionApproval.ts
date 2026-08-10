import { useCallback, useEffect, useState } from "react";
import type { PermissionApprovalPrompt, PermissionApprovalResponse } from "../../shared/ipc";
import { getBridge } from "../desktopApi";

export function usePermissionApproval(props: { onError(error: string): void }) {
  const { onError } = props;
  const [queue, setQueue] = useState<PermissionApprovalPrompt[]>([]);
  const activePrompt = queue[0] ?? null;

  useEffect(() => {
    const bridge = getBridge();
    const offPrompt = bridge.onPermissionApproval((prompt) => {
      setQueue((current) => [
        ...current.filter((item) => item.id !== prompt.id),
        prompt
      ]);
    });
    const offCancelled = bridge.onPermissionApprovalCancelled((id) => {
      setQueue((current) => current.filter((item) => item.id !== id));
    });
    return () => {
      offPrompt();
      offCancelled();
    };
  }, []);

  const answer = useCallback(async (response: PermissionApprovalResponse) => {
    setQueue((current) => current.filter((item) => item.id !== response.id));
    try {
      await getBridge().answerPermissionApproval(response);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }, [onError]);

  return { activePrompt, answer };
}
