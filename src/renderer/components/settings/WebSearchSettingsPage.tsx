import { useEffect, useState } from "react";
import type { WebSearchSettings, WebSearchSettingsUpdateRequest } from "../../../shared/ipc";
import { SettingsHeader } from "./SettingsHeader";
import { useI18n } from "../../i18n";
import { Switch, TextInput } from "../ui";
import { SettingsActions, SettingsPage, SettingsRow, SettingsSection, StatePill } from "./SettingsLayout";

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
    setDraft({ ...props.settings, provider: "duckduckgo" });
    setSaveState("idle");
  }, [props.settings.updatedAt]);

  useEffect(() => {
    setSaveState("idle");
  }, [draft.enabled, draft.maxResults, draft.timeoutMs]);

  const dirty =
    draft.enabled !== props.settings.enabled ||
    draft.provider !== props.settings.provider ||
    draft.maxResults !== props.settings.maxResults ||
    draft.timeoutMs !== props.settings.timeoutMs;

  async function save() {
    setSaveState("saving");
    const result = await props.onUpdate({
      enabled: draft.enabled,
      provider: "duckduckgo",
      maxResults: draft.maxResults,
      timeoutMs: draft.timeoutMs
    });
    setSaveState(result ? "saved" : "failed");
  }

  return (
    <>
      <SettingsHeader title={t("settings.web.title")} />
      <SettingsPage>
        <SettingsSection>
          <SettingsRow
            label={t("settings.web.use")}
            actions={
              <Switch
                checked={draft.enabled}
                aria-label={t("settings.web.use")}
                disabled={props.saving || props.loading}
                onChange={(checked) => setDraft((current) => ({ ...current, enabled: checked }))}
              />
            }
          />
          <SettingsRow
            label={t("settings.web.results")}
            actions={
              <TextInput
                type="number"
                min={1}
                max={8}
                value={draft.maxResults}
                aria-label={t("settings.web.resultLimit")}
                disabled={props.saving || props.loading}
                onChange={(event) => setDraft((current) => ({ ...current, maxResults: Number(event.target.value) }))}
              />
            }
          />
          <SettingsRow
            label={t("settings.web.timeout")}
            actions={
              <TextInput
                type="number"
                min={1500}
                max={15000}
                step={500}
                value={draft.timeoutMs}
                aria-label={t("settings.web.timeoutAria")}
                disabled={props.saving || props.loading}
                onChange={(event) => setDraft((current) => ({ ...current, timeoutMs: Number(event.target.value) }))}
              />
            }
          />
          <SettingsRow
            label={t("settings.web.last")}
            description={props.settings.lastError ? props.settings.lastError : t("settings.web.lastDescription")}
            actions={
              <StatePill tone={props.settings.lastError ? "danger" : props.settings.enabled ? "success" : "neutral"}>
                {props.settings.lastRunAt ? new Date(props.settings.lastRunAt).toLocaleString() : t("app.never")}
              </StatePill>
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
