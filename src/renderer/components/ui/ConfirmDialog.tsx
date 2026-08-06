import { useI18n } from "../../i18n";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t } = useI18n();

  return (
    <Dialog
      open={props.open}
      title={props.title}
      className="confirm-dialog"
      onClose={props.onCancel}
      closeLabel={t("app.close")}
      body={<p>{props.body}</p>}
      actions={
        <>
          <Button variant="ghost" onClick={props.onCancel}>{t("app.cancel")}</Button>
          <Button variant="danger" onClick={props.onConfirm}>{props.confirmLabel}</Button>
        </>
      }
    />
  );
}
