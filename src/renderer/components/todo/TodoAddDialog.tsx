import { useEffect, useRef, useState } from "react";
import { Button, Dialog, TextArea } from "../ui";
import { useI18n } from "../../i18n";

export function TodoAddDialog(props: {
  open: boolean;
  saving: boolean;
  projectName?: string | null;
  onClose(): void;
  onSave(text: string): Promise<boolean>;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const error = submitted && text.trim().length === 0 ? t("todo.add.empty") : "";

  useEffect(() => {
    if (!props.open) return;
    setText("");
    setSubmitted(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [props.open]);

  async function submit() {
    setSubmitted(true);
    const trimmed = text.trim();
    if (!trimmed) return;
    const saved = await props.onSave(trimmed);
    if (saved) props.onClose();
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("todo.add.title")}
      closeLabel={t("app.close")}
      initialFocusRef={textareaRef}
      className="todo-add-dialog"
      body={
        <div className="todo-add-body">
          {props.projectName ? (
            <p className="todo-add-context">{t("todo.add.projectContext", { project: props.projectName })}</p>
          ) : (
            <p className="todo-add-context">{t("todo.add.inboxContext")}</p>
          )}
          <TextArea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            aria-label={t("todo.add.input")}
            placeholder={t("todo.add.placeholder")}
            rows={6}
            error={error}
          />
        </div>
      }
      actions={
        <>
          <Button variant="quiet" onClick={props.onClose} disabled={props.saving}>
            {t("app.cancel")}
          </Button>
          <Button variant="primary" loading={props.saving} onClick={() => void submit()}>
            {t("todo.add.save")}
          </Button>
        </>
      }
    />
  );
}
