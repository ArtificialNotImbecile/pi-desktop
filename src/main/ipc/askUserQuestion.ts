import { ipcMain, type WebContents } from "electron";
import type { AskUserQuestionPrompt, AskUserQuestionResponse } from "../../shared/ipc.js";
import { askUserQuestionResponseSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";
import { abortError } from "../utils/abort.js";

type PendingQuestion = {
  reject(error: Error): void;
  resolve(response: AskUserQuestionResponse): void;
  sender: WebContents;
};

const pendingQuestions = new Map<string, PendingQuestion>();

export function registerAskUserQuestionIpc(_context: IpcContext): void {
  ipcMain.handle("askUserQuestion:answer", (_event, response: AskUserQuestionResponse): void => {
    response = askUserQuestionResponseSchema.parse(response);
    const pending = pendingQuestions.get(response.id);
    if (!pending) return;
    pendingQuestions.delete(response.id);
    pending.resolve(response);
  });
}

export function askUserQuestionInRenderer(
  sender: WebContents,
  prompt: Omit<AskUserQuestionPrompt, "id">,
  signal?: AbortSignal
): Promise<AskUserQuestionResponse> {
  const id = `ask-user-question-${crypto.randomUUID()}`;
  const payload: AskUserQuestionPrompt = {
    id,
    questions: prompt.questions
  };

  return new Promise((resolve, reject) => {
    const abort = () => {
      pendingQuestions.delete(id);
      // The abort listener can fire during app teardown after the renderer is
      // gone; sending to a destroyed WebContents crashes the main process.
      if (!sender.isDestroyed()) sender.send("askUserQuestion:cancelled", id);
      reject(abortError("AskUserQuestion was cancelled because the response stopped."));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    pendingQuestions.set(id, {
      sender,
      resolve: (response) => {
        signal?.removeEventListener("abort", abort);
        resolve(response);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", abort);
        reject(error);
      }
    });

    signal?.addEventListener("abort", abort, { once: true });
    sender.send("askUserQuestion:prompt", payload);
  });
}
