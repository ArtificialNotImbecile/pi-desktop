import { useEffect, useMemo, useState } from "react";
import type { AppSettings, AppSettingsUpdateRequest, ChromeTakeoverStatus } from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";
import { useI18n } from "../../i18n";
import { errorMessage } from "../../utils/errors";
import { Button, IconButton, Switch, TextInput } from "../ui";
import { CopyIcon, PlugIcon, RefreshIcon } from "../icons/Icons";
import { SettingsActions, SettingsPage, SettingsRow, SettingsSection, StatePill } from "./SettingsLayout";
import { SettingsHeader } from "./SettingsHeader";

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export function ChromeControlSettingsPage(props: {
  settings: AppSettings;
  saving: boolean;
  onUpdateSettings(request: AppSettingsUpdateRequest): Promise<AppSettings | null>;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ChromeTakeoverStatus | null>(null);
  const [extensionId, setExtensionId] = useState(props.settings.chromeTakeover.extensionId ?? "");
  const [actionState, setActionState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [actionKind, setActionKind] = useState<"enable" | "disable">("enable");
  const [statusError, setStatusError] = useState("");
  const normalizedExtensionId = extensionId.trim().toLowerCase();
  const extensionIdInvalid = normalizedExtensionId.length > 0 && !EXTENSION_ID_PATTERN.test(normalizedExtensionId);
  const canRegister = EXTENSION_ID_PATTERN.test(normalizedExtensionId);
  const extensionPath = status?.extensionPath ?? "";
  const enabled = status?.enabled ?? props.settings.chromeTakeover.enabled;

  useEffect(() => {
    setExtensionId(props.settings.chromeTakeover.extensionId ?? "");
  }, [props.settings.chromeTakeover.extensionId]);

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    setActionState("idle");
  }, [extensionId]);

  const statusRows = useMemo(() => [
    {
      label: t("settings.chrome.status.enabled"),
      value: enabled ? t("app.enabled") : t("app.disabled"),
      tone: enabled ? "success" : "neutral"
    },
    {
      label: t("settings.chrome.status.bridge"),
      value: status?.bridgeRunning ? t("settings.chrome.running") : t("settings.chrome.notRunning"),
      tone: status?.bridgeRunning ? "success" : "neutral"
    },
    {
      label: t("settings.chrome.status.host"),
      value: status?.hostRegistered ? t("settings.chrome.registered") : t("settings.chrome.notRegistered"),
      tone: status?.hostRegistered ? "success" : "neutral"
    },
    {
      label: t("settings.chrome.status.extension"),
      value: status?.extensionConnected ? t("settings.chrome.connected") : t("settings.chrome.notConnected"),
      tone: status?.extensionConnected ? "success" : "warning"
    }
  ] satisfies Array<{ label: string; value: string; tone: "neutral" | "success" | "warning" }>, [enabled, status?.bridgeRunning, status?.extensionConnected, status?.hostRegistered, t]);

  async function refreshStatus() {
    try {
      setStatusError("");
      const next = await getBridge().getChromeTakeoverStatus();
      setStatus(next);
      if (!extensionId.trim() && next.extensionId) setExtensionId(next.extensionId);
    } catch (caught) {
      setStatusError(errorMessage(caught, t("settings.chrome.statusFailed")));
    }
  }

  async function register() {
    if (!canRegister) {
      setStatusError(t("settings.chrome.extensionIdInvalid"));
      setActionState("failed");
      return;
    }
    setActionKind("enable");
    setActionState("saving");
    setStatusError("");
    try {
      const next = await getBridge().registerChromeTakeover({ extensionId: normalizedExtensionId });
      setStatus(next);
      const updated = await props.onUpdateSettings({ chromeTakeover: { enabled: true, extensionId: normalizedExtensionId } });
      if (!updated) throw new Error(t("settings.chrome.enableFailed"));
      setActionState("saved");
    } catch (caught) {
      setStatusError(errorMessage(caught, t("settings.chrome.enableFailed")));
      setActionState("failed");
    }
  }

  async function setEnabled(nextEnabled: boolean) {
    setActionKind(nextEnabled ? "enable" : "disable");
    setActionState("saving");
    setStatusError("");
    try {
      if (!nextEnabled) {
        const next = await getBridge().disableChromeTakeover();
        setStatus(next);
        setActionState("saved");
        return;
      }
      const result = await props.onUpdateSettings({
        chromeTakeover: {
          enabled: true,
          extensionId: normalizedExtensionId || props.settings.chromeTakeover.extensionId
        }
      });
      if (!result) throw new Error(t("settings.chrome.enableFailed"));
      setActionState("saved");
      void refreshStatus();
    } catch (caught) {
      const fallback = nextEnabled ? t("settings.chrome.enableFailed") : t("settings.chrome.disableFailed");
      setStatusError(errorMessage(caught, fallback));
      setActionState("failed");
    }
  }

  async function copyExtensionPath() {
    if (!extensionPath) return;
    try {
      await getBridge().writeClipboardText(extensionPath);
      setActionState("saved");
    } catch (caught) {
      setStatusError(errorMessage(caught, t("settings.chrome.copyFailed")));
      setActionState("failed");
    }
  }

  return (
    <>
      <SettingsHeader title={t("settings.chrome.title")} />
      <SettingsPage className="chrome-control-page">
        <SettingsSection>
          <SettingsRow
            label={t("settings.chrome.realChrome")}
            description={t("settings.chrome.consent")}
            actions={
              <div className="chrome-control-toggle">
                <StatePill tone={enabled ? "success" : "neutral"}>{enabled ? t("app.enabled") : t("app.disabled")}</StatePill>
                <Switch
                  checked={enabled}
                  disabled={props.saving || actionState === "saving"}
                  aria-label={enabled ? t("settings.chrome.disable") : t("settings.chrome.enable")}
                  onChange={(value) => void setEnabled(value)}
                />
              </div>
            }
          />
        </SettingsSection>

        <SettingsSection title={t("settings.chrome.statusTitle")} aria-label={t("settings.chrome.statusTitle")}>
          <div className="chrome-status-grid">
            {statusRows.map((row) => (
              <div key={row.label} className="chrome-status-item">
                <span>{row.label}</span>
                <StatePill tone={row.tone}>{row.value}</StatePill>
              </div>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection title={t("settings.chrome.extensionTitle")} aria-label={t("settings.chrome.extensionTitle")}>
          <SettingsRow
            label={t("settings.chrome.extensionPath")}
            description={t("settings.chrome.extensionPathDescription")}
            actions={
              <div className="chrome-extension-path-row">
                <TextInput
                  aria-label={t("settings.chrome.extensionPath")}
                  value={extensionPath || t("settings.chrome.extensionPathMissing")}
                  readOnly
                />
                <IconButton label={t("settings.chrome.copyPath")} size="sm" disabled={!extensionPath} onClick={() => void copyExtensionPath()}>
                  <CopyIcon />
                </IconButton>
                <IconButton label={t("app.refresh")} size="sm" onClick={() => void refreshStatus()}>
                  <RefreshIcon />
                </IconButton>
              </div>
            }
          />
          <SettingsRow
            label={t("settings.chrome.extensionId")}
            description={t("settings.chrome.extensionIdDescription")}
            actions={
              <TextInput
                aria-label={t("settings.chrome.extensionId")}
                value={extensionId}
                placeholder="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                maxLength={32}
                spellCheck={false}
                error={extensionIdInvalid ? t("settings.chrome.extensionIdInvalid") : false}
                onChange={(event) => setExtensionId(event.target.value)}
              />
            }
          />
        </SettingsSection>

        <SettingsActions
          state={props.saving ? "saving" : actionState}
          savingLabel={actionKind === "disable" ? t("settings.chrome.disabling") : t("settings.chrome.enabling")}
          savedLabel={actionKind === "disable" ? t("settings.chrome.disabled") : t("settings.chrome.enabled")}
          failedLabel={statusError || (actionKind === "disable" ? t("settings.chrome.disableFailed") : t("settings.chrome.enableFailed"))}
        >
          <Button
            variant="primary"
            leftIcon={<PlugIcon />}
            loading={actionState === "saving" || props.saving}
            disabled={!canRegister || actionState === "saving" || props.saving}
            onClick={() => void register()}
          >
            {t("settings.chrome.registerEnable")}
          </Button>
        </SettingsActions>
      </SettingsPage>
    </>
  );
}
