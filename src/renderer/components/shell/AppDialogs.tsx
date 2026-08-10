import type { AskUserQuestionPrompt, AskUserQuestionResponse, ChatMessage, ChatThread, MemoryRecord, PermissionApprovalPrompt, PermissionApprovalResponse } from "../../../shared/ipc";
import { AskUserQuestionDialog } from "../chat/AskUserQuestionDialog";
import { PermissionApprovalDialog } from "../chat/PermissionApprovalDialog";
import { RememberDialog } from "../memory/RememberDialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Toast } from "../ui/Toast";
import { useI18n } from "../../i18n";

export function AppDialogs(props: {
  deleteThreadCandidate: ChatThread | null;
  deleteMemoryCandidate: MemoryRecord | null;
  rememberingMessage: ChatMessage | null;
  askUserQuestionPrompt: AskUserQuestionPrompt | null;
  permissionApprovalPrompt: PermissionApprovalPrompt | null;
  toast: string | null;
  onCancelDeleteThread(): void;
  onConfirmDeleteThread(thread: ChatThread): void;
  onCancelDeleteMemory(): void;
  onConfirmDeleteMemory(memory: MemoryRecord): void;
  onCancelRemember(): void;
  onConfirmRemember(content: string, message: ChatMessage): void;
  onAnswerAskUserQuestion(response: AskUserQuestionResponse): void;
  onAnswerPermissionApproval(response: PermissionApprovalResponse): void;
}) {
  const { t } = useI18n();
  return (
    <>
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

      <PermissionApprovalDialog
        prompt={props.permissionApprovalPrompt}
        onAnswer={props.onAnswerPermissionApproval}
      />

      <Toast label={props.toast} />
    </>
  );
}
