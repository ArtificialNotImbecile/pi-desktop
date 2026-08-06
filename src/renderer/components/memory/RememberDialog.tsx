import { useState } from "react";
import type { ChatMessage } from "../../../shared/ipc";
import { useI18n } from "../../i18n";

export function RememberDialog(props: {
  message: ChatMessage | null;
  onCancel(): void;
  onConfirm(content: string, message: ChatMessage): void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");

  if (!props.message) return null;
  const content = draft || props.message.content;

  return (
    <div className="memory-dialog-backdrop" role="dialog" aria-modal="true" aria-label={t("memory.rememberDialog")}>
      <form
        className="memory-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = content.trim();
          if (!trimmed || !props.message) return;
          props.onConfirm(trimmed, props.message);
          setDraft("");
        }}
      >
        <div className="memory-dialog-header">
          <strong>{t("memory.rememberTitle")}</strong>
        </div>
        <textarea
          value={content}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={t("memory.content")}
        />
        <div className="memory-dialog-actions">
          <button type="button" onClick={() => { setDraft(""); props.onCancel(); }}>{t("app.cancel")}</button>
          <button type="submit" className="primary" disabled={!content.trim()}>{t("memory.save")}</button>
        </div>
      </form>
    </div>
  );
}
