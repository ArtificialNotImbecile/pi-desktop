import { useCallback, useEffect, useState } from "react";
import type { AskUserQuestionPrompt, AskUserQuestionResponse } from "../../shared/ipc";
import { getBridge } from "../desktopApi";

export function useAskUserQuestion(props: {
  onError(error: string): void;
}) {
  const { onError } = props;
  const [queue, setQueue] = useState<AskUserQuestionPrompt[]>([]);
  const activePrompt = queue[0] ?? null;

  useEffect(() => {
    const bridge = getBridge();
    const offPrompt = bridge.onAskUserQuestion((prompt) => {
      setQueue((current) => {
        const withoutDuplicate = current.filter((item) => item.id !== prompt.id);
        return [...withoutDuplicate, prompt];
      });
    });
    const offCancelled = bridge.onAskUserQuestionCancelled((id) => {
      setQueue((current) => current.filter((item) => item.id !== id));
    });
    return () => {
      offPrompt();
      offCancelled();
    };
  }, []);

  const answer = useCallback(async (response: AskUserQuestionResponse) => {
    setQueue((current) => current.filter((item) => item.id !== response.id));
    try {
      await getBridge().answerAskUserQuestion(response);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }, [onError]);

  return {
    activePrompt,
    answer
  };
}
