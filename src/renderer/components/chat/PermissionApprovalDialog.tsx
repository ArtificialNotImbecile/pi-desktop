import type { PermissionApprovalPrompt, PermissionApprovalResponse } from "../../../shared/ipc";
import { useI18n, type I18nKey } from "../../i18n";
import { Button, Dialog } from "../ui";

export function PermissionApprovalDialog(props: {
  prompt: PermissionApprovalPrompt | null;
  onAnswer(response: PermissionApprovalResponse): void;
}) {
  const { t } = useI18n();
  const prompt = props.prompt;
  if (!prompt) return null;

  const sensitiveValue = prompt.command ?? prompt.path ?? prompt.resolvedPath ?? "";
  const promptId = prompt.id;

  function answer(decision: PermissionApprovalResponse["decision"]) {
    props.onAnswer({ id: promptId, decision });
  }

  return (
    <Dialog
      className="permission-approval-dialog"
      closeOnOutside={false}
      onClose={() => undefined}
      open
      showClose={false}
      title={t("permission.title")}
      body={<p>{reasonLabel(prompt.reason, t)}</p>}
      actions={(
        <>
          <Button type="button" onClick={() => answer("deny")}>{t("permission.deny")}</Button>
          <Button type="button" variant="primary" onClick={() => answer("allow-once")}>{t("permission.allowOnce")}</Button>
        </>
      )}
    >
      <section className="permission-approval-content" aria-label={t("permission.details")}>
        <div className="permission-approval-summary">
          <strong>{prompt.summary}</strong>
          <span>{prompt.toolName}</span>
        </div>
        {sensitiveValue ? <pre className="permission-approval-command"><code>{sensitiveValue}</code></pre> : null}
        <dl className="permission-approval-meta">
          <div><dt>{t("permission.cwd")}</dt><dd>{prompt.cwd}</dd></div>
          {prompt.projectRoot ? <div><dt>{t("permission.project")}</dt><dd>{prompt.projectRoot}</dd></div> : null}
          {prompt.resolvedPath && prompt.resolvedPath !== prompt.path ? <div><dt>{t("permission.resolvedPath")}</dt><dd>{prompt.resolvedPath}</dd></div> : null}
        </dl>
        <p className="permission-approval-note">{t("permission.allowOnceNote")}</p>
      </section>
    </Dialog>
  );
}

function reasonLabel(
  reason: PermissionApprovalPrompt["reason"],
  t: (key: I18nKey, variables?: Record<string, string | number>) => string
): string {
  if (reason === "bash") return t("permission.reason.bash");
  if (reason === "outside-project") return t("permission.reason.outsideProject");
  if (reason === "no-project") return t("permission.reason.noProject");
  return t("permission.reason.unresolvedPath");
}
