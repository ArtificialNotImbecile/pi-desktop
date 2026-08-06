import type { AskUserQuestionPrompt, AskUserQuestionResponse, ChatMessage, ChatThread, MemoryRecord } from "../../../shared/ipc";
import { AskUserQuestionDialog } from "../chat/AskUserQuestionDialog";
import { RememberDialog } from "../memory/RememberDialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Toast } from "../ui/Toast";
import { useI18n } from "../../i18n";

export function AppDialogs(props: {
  clearHistoryOpen: boolean;
  deleteThreadCandidate: ChatThread | null;
  deleteMemoryCandidate: MemoryRecord | null;
  rememberingMessage: ChatMessage | null;
  askUserQuestionPrompt: AskUserQuestionPrompt | null;
  toast: string | null;
  onCancelClearHistory(): void;
  onConfirmClearHistory(): void;
  onCancelDeleteThread(): void;
  onConfirmDeleteThread(thread: ChatThread): void;
  onCancelDeleteMemory(): void;
  onConfirmDeleteMemory(memory: MemoryRecord): void;
  onCancelRemember(): void;
  onConfirmRemember(content: string, message: ChatMessage): void;
  onAnswerAskUserQuestion(response: AskUserQuestionResponse): void;
}) {
  const { t } = useI18n();
  return (
    <>
      <ConfirmDialog
        open={props.clearHistoryOpen}
        title={t("dialogs.clearTitle")}
        body={t("dialogs.clearBody")}
        confirmLabel={t("dialogs.clearConfirm")}
        onCancel={props.onCancelClearHistory}
        onConfirm={props.onConfirmClearHistory}
      />

      <ConfirmDialog
        open={Boolean(props.deleteThreadCandidate)}
        title={t("dialogs.deleteChatTitle")}
        body={props.deleteThreadCandidate ? t("dialogs.deleteChatBody", { title: props.deleteThreadCandidate.title }) : t("dialogs.deleteChatFallback")}
        confirmLabel={t("dialogs.deleteChatConfirm")}
        onCancel={props.onCancelDeleteThread}
        onConfirm={() => {
          if (props.deleteThreadCandidate) props.onConfirmDeleteThread(props.deleteThreadCandidate);
        }}
      />

      <ConfirmDialog
        open={Boolean(props.deleteMemoryCandidate)}
        title={t("dialogs.deleteMemoryTitle")}
        body={t("dialogs.deleteMemoryBody")}
        confirmLabel={t("app.delete")}
        onCancel={props.onCancelDeleteMemory}
        onConfirm={() => {
          if (props.deleteMemoryCandidate) props.onConfirmDeleteMemory(props.deleteMemoryCandidate);
        }}
      />

      <RememberDialog
        message={props.rememberingMessage}
        onCancel={props.onCancelRemember}
        onConfirm={props.onConfirmRemember}
      />

      <AskUserQuestionDialog
        prompt={props.askUserQuestionPrompt}
        onAnswer={props.onAnswerAskUserQuestion}
      />

      <Toast label={props.toast} />
    </>
  );
}
