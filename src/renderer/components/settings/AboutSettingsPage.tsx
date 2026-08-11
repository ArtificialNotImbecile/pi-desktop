import type { AppUpdateInstallMode, AppUpdatePhase } from "../../../shared/ipc";
import { useAppUpdater } from "../../hooks/useAppUpdater";
import { useI18n, type I18nKey } from "../../i18n";
import { Button } from "../ui";
import { SettingsHeader } from "./SettingsHeader";
import { SettingsPage, SettingsRow, SettingsSection } from "./SettingsLayout";

export function AboutSettingsPage() {
  const { t } = useI18n();
  const updater = useAppUpdater();
  const { state } = updater;
  const statusKey = updateStatusKey(state.phase, state.installMode);
  const progress = state.progressPercent === null ? 0 : Math.min(100, Math.max(0, state.progressPercent));
  const version = state.currentVersion || t("app.loading");

  return (
    <>
      <SettingsHeader title={t("settings.about.title")} />
      <SettingsPage className="about-settings-page">
        <SettingsSection>
          <SettingsRow
            label={t("settings.about.positioning")}
            description={t("settings.about.description")}
          />
          <SettingsRow
            label={t("settings.about.version")}
            description={t("settings.about.versionDescription")}
            actions={<span className="settings-state-pill" data-testid="app-current-version">{version}</span>}
          />
          <SettingsRow
            className="about-update-row"
            label={t("settings.about.updates")}
            description={(
              <>
                <span>{t(statusKey, { version: state.availableVersion || "" })}</span>
                {state.phase === "downloading" ? (
                  <span className="about-update-progress">
                    <progress aria-label={t("settings.about.downloadProgress")} max={100} value={progress} />
                    <span>
                      {t("settings.about.downloadProgressValue", {
                        percent: Math.round(progress),
                        transferred: formatBytes(state.transferredBytes),
                        total: formatBytes(state.totalBytes)
                      })}
                    </span>
                  </span>
                ) : null}
                {state.error ? <span className="about-update-error" role="alert">{state.error}</span> : null}
              </>
            )}
            actions={renderUpdateAction()}
          />
          <SettingsRow
            label={t("settings.about.dataLocation")}
            description={t("settings.about.dataLocationDescription")}
            actions={<span className="settings-state-pill">{t("app.localOnly")}</span>}
          />
        </SettingsSection>
      </SettingsPage>
    </>
  );

  function renderUpdateAction() {
    if (state.phase === "available") {
      // Builds that cannot replace themselves still report the new version;
      // the download page is the only action that can finish the job.
      if (state.installMode === "manual") {
        return (
          <Button size="sm" variant="primary" onClick={() => void updater.openDownloadPage()}>
            {t("settings.about.openDownloadPage")}
          </Button>
        );
      }
      return (
        <Button size="sm" variant="primary" onClick={() => void updater.download()}>
          {t("settings.about.downloadUpdate")}
        </Button>
      );
    }
    if (state.phase === "downloaded") {
      return (
        <Button size="sm" variant="primary" onClick={() => void updater.install()}>
          {t("settings.about.restartInstall")}
        </Button>
      );
    }
    const busy = updater.loading || state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
    const disabledReason = !state.supported ? t("settings.about.installedBuildOnly") : undefined;
    return (
      <Button
        size="sm"
        disabled={busy || !state.supported}
        title={disabledReason}
        onClick={() => void updater.check()}
      >
        {state.phase === "checking"
          ? t("settings.about.checking")
          : state.phase === "downloading"
            ? t("settings.about.downloading")
            : state.phase === "installing"
              ? t("settings.about.installing")
              : t("settings.about.checkUpdate")}
      </Button>
    );
  }
}

function updateStatusKey(phase: AppUpdatePhase, installMode: AppUpdateInstallMode): I18nKey {
  if (phase === "available" && installMode === "manual") return "settings.about.updateAvailableManual";
  const keys: Record<AppUpdatePhase, I18nKey> = {
    unsupported: "settings.about.updateUnsupported",
    idle: "settings.about.updateIdle",
    checking: "settings.about.updateChecking",
    "up-to-date": "settings.about.updateCurrent",
    available: "settings.about.updateAvailable",
    downloading: "settings.about.updateDownloading",
    downloaded: "settings.about.updateDownloaded",
    installing: "settings.about.updateInstalling",
    error: "settings.about.updateError"
  };
  return keys[phase];
}

function formatBytes(value: number | null): string {
  if (value === null || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
