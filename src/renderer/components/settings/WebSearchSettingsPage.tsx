import { useEffect, useState } from "react";
import type { WebSearchSettings, WebSearchSettingsUpdateRequest } from "../../../shared/ipc";
import { SettingsHeader } from "./SettingsHeader";
import { useI18n } from "../../i18n";
import { Switch } from "../ui";
import { SettingsActions, SettingsPage, SettingsRow, SettingsSection } from "./SettingsLayout";

export function WebSearchSettingsPage(props: {
  settings: WebSearchSettings;
  loading: boolean;
  saving: boolean;
  onClose(): void;
  onUpdate(request: WebSearchSettingsUpdateRequest): Promise<WebSearchSettings | null>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<WebSearchSettings>(props.settings);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  useEffect(() => {
    setDraft(props.settings);
    setSaveState("idle");
  }, [props.settings.updatedAt]);

  useEffect(() => {
    setSaveState("idle");
  }, [draft.enabled]);

  const dirty = draft.enabled !== props.settings.enabled;

  async function save() {
    setSaveState("saving");
    const result = await props.onUpdate({ enabled: draft.enabled });
    setSaveState(result ? "saved" : "failed");
  }

  return (
    <>
      <SettingsHeader title={t("settings.web.title")} />
      <SettingsPage>
        <SettingsSection>
          <SettingsRow
            label={t("settings.web.use")}
            description={t("settings.web.useDescription")}
            actions={
              <Switch
                checked={draft.enabled}
                aria-label={t("settings.web.use")}
                disabled={props.saving || props.loading}
                onChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
              />
            }
          />
        </SettingsSection>
        <SettingsActions
          state={saveState}
          dirty={dirty}
          disabled={props.saving || props.loading}
          savingLabel={t("app.saving")}
          savedLabel={t("app.saved")}
          failedLabel={t("app.saveFailed")}
          saveLabel={t("app.save")}
          onSave={() => void save()}
        />
      </SettingsPage>
    </>
  );
}
