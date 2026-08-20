import { useEffect, useState } from "react";
import type {
  RemoteDoctorReport,
  RemoteProfileStatus,
  RemoteProfileSummary,
  RemoteWorkspace
} from "../../../shared/ipc";
import { useI18n, type I18nKey } from "../../i18n";
import { PlusIcon, RefreshIcon, ServerIcon, TrashIcon } from "../icons/Icons";
import { Button, ConfirmDialog, EmptyState } from "../ui";
import { SettingsHeader } from "./SettingsHeader";
import { SettingsList, SettingsListRow, SettingsPage, SettingsRow, SettingsSection, SettingsToolbar, StatePill } from "./SettingsLayout";

export function RemoteSettingsPage(props: {
  profiles: RemoteProfileSummary[];
  workspaces: RemoteWorkspace[];
  statuses: Record<string, RemoteProfileStatus>;
  selectedProfileId: string | null;
  onSelectProfile(profileId: string): void;
  onAddProfile(): void;
  onAddWorkspace(profileId: string): void;
  onRemoveProfile(profileId: string): Promise<unknown>;
  onCheck(profileId: string): Promise<RemoteDoctorReport | null>;
  onInstall(profileId: string): Promise<boolean>;
  onStop(profileId: string): Promise<boolean>;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<RemoteDoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const selected = props.profiles.find((profile) => profile.id === props.selectedProfileId)
    ?? props.profiles[0]
    ?? null;
  const selectedId = selected?.id ?? null;

  // The report belongs to one profile; switching profiles must not leave the
  // previous host's checks on screen.
  useEffect(() => {
    setReport(null);
  }, [selectedId]);

  const status = selectedId ? props.statuses[selectedId] : undefined;
  const workspaces = props.workspaces.filter((workspace) => workspace.profileId === selectedId);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsHeader title={t("remote.settings.title")} />
      <SettingsPage className="remote-settings-page" title={t("remote.settings.title")} subtitle={t("remote.settings.subtitle")}>
        <SettingsToolbar>
          <Button size="sm" leftIcon={<PlusIcon />} onClick={props.onAddProfile}>{t("remote.addProfile")}</Button>
        </SettingsToolbar>

        {props.profiles.length === 0 ? (
          <EmptyState
            icon={<ServerIcon />}
            title={t("remote.settings.noProfiles")}
            action={<Button variant="primary" onClick={props.onAddProfile}>{t("remote.addProfile")}</Button>}
          />
        ) : (
          <div className="remote-settings-body">
            <SettingsList ariaLabel={t("remote.settings.profiles")} className="remote-settings-profiles">
              {props.profiles.map((profile) => (
                <button
                  className={`remote-settings-profile ${profile.id === selectedId ? "active" : ""}`}
                  key={profile.id}
                  type="button"
                  aria-current={profile.id === selectedId ? "true" : undefined}
                  onClick={() => props.onSelectProfile(profile.id)}
                >
                  <span className={`remote-status-dot ${props.statuses[profile.id]?.state ?? "unknown"}`} aria-hidden="true" />
                  <span className="remote-settings-profile-name">{profile.name}</span>
                  <small>{profile.sshHost}</small>
                </button>
              ))}
            </SettingsList>

            {selected ? (
              <div className="remote-settings-detail">
                <SettingsSection title={t("remote.settings.overview")}>
                  <SettingsRow label={t("remote.settings.host")}>
                    <span>{selected.sshHost}</span>
                  </SettingsRow>
                  <SettingsRow label={t("remote.settings.port")}>
                    <span>{selected.sshPort ?? t("remote.settings.none")}</span>
                  </SettingsRow>
                  <SettingsRow label={t("remote.settings.defaultCwd")}>
                    <span>{selected.defaultCwd ?? t("remote.settings.none")}</span>
                  </SettingsRow>
                  <SettingsRow label={t("remote.egress.label")} description={
                    selected.networkMode === "client-proxy" ? t("remote.egress.proxyDescription") : t("remote.egress.directDescription")
                  }>
                    <StatePill tone={selected.networkMode === "client-proxy" ? "accent" : "neutral"}>
                      {selected.networkMode === "client-proxy" ? t("remote.egress.proxy") : t("remote.egress.direct")}
                    </StatePill>
                  </SettingsRow>
                </SettingsSection>

                <SettingsSection title={t("remote.doctor.title")}>
                  <SettingsRow
                    label={t(statusKey(status))}
                    description={status?.message ?? status?.remediation ?? undefined}
                    actions={
                      <Button size="sm" leftIcon={<RefreshIcon />} loading={busy} onClick={() => void run(async () => setReport(await props.onCheck(selected.id)))}>
                        {t("remote.doctor.run")}
                      </Button>
                    }
                  />
                  {report ? (
                    <ul className="remote-doctor-list">
                      {report.checks.map((check) => (
                        <li key={check.id}>
                          <StatePill tone={checkTone(check.status)}>{t(checkStatusKey(check.status))}</StatePill>
                          <span>{check.message}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="remote-settings-hint">{t("remote.doctor.notRun")}</p>
                  )}
                </SettingsSection>

                <SettingsSection title={t("remote.settings.workspaces")}>
                  {workspaces.length === 0 ? (
                    <p className="remote-settings-hint">{t("remote.noWorkspaces")}</p>
                  ) : workspaces.map((workspace) => (
                    <SettingsListRow
                      key={workspace.id}
                      title={workspace.name}
                      description={workspace.cwd}
                      status={workspace.isDefaultCwd ? <StatePill tone="accent">{t("remote.workspace.default")}</StatePill> : null}
                      meta={t("remote.session.count", { count: workspace.sessionCount })}
                    />
                  ))}
                  <SettingsRow label={t("remote.addWorkspace")} actions={
                    <Button size="sm" leftIcon={<PlusIcon />} onClick={() => props.onAddWorkspace(selected.id)}>
                      {t("remote.workspace.add")}
                    </Button>
                  } />
                </SettingsSection>

                <SettingsSection title={t("remote.settings.network")}>
                  {selected.networkMode === "client-proxy" ? (
                    <>
                      <SettingsRow label={t("remote.settings.proxyPorts")}>
                        <span>{selected.allowedPorts.join(", ")}</span>
                      </SettingsRow>
                      <SettingsRow label={t("remote.settings.proxyNoProxy")}>
                        <span>{selected.noProxy.length > 0 ? selected.noProxy.join(", ") : t("remote.settings.none")}</span>
                      </SettingsRow>
                      <SettingsRow label={t("remote.settings.proxyUpstream")}>
                        <span>{selected.upstreamProxyEnv ?? t("remote.settings.none")}</span>
                      </SettingsRow>
                      <p className="remote-settings-hint">{t("remote.wizard.proxyNotice")}</p>
                    </>
                  ) : (
                    <p className="remote-settings-hint">{t("remote.settings.directOnly")}</p>
                  )}
                </SettingsSection>

                <SettingsSection title={t("remote.settings.runtime")}>
                  <SettingsRow label={t("remote.settings.runtimeVersion")}>
                    <span>{status?.runtimeVersion ?? t("remote.settings.none")}</span>
                  </SettingsRow>
                  <SettingsRow label={t("remote.settings.piVersion")}>
                    <span>{status?.piVersion ?? t("remote.settings.none")}</span>
                  </SettingsRow>
                  <SettingsRow label={t("remote.settings.installRuntime")} description={t("remote.wizard.installHint")} actions={
                    <Button size="sm" loading={busy} onClick={() => void run(() => props.onInstall(selected.id))}>
                      {t("remote.settings.installRuntime")}
                    </Button>
                  } />
                  <SettingsRow label={t("remote.settings.stop")} description={t("remote.settings.stopHint")} actions={
                    <Button size="sm" variant="quiet" loading={busy} onClick={() => void run(() => props.onStop(selected.id))}>
                      {t("remote.settings.stop")}
                    </Button>
                  } />
                  <SettingsRow label={t("remote.settings.remove")} description={t("remote.settings.removeBody")} actions={
                    <Button size="sm" variant="danger" leftIcon={<TrashIcon />} onClick={() => setConfirmRemove(true)}>
                      {t("app.delete")}
                    </Button>
                  } />
                </SettingsSection>

                <ConfirmDialog
                  open={confirmRemove}
                  title={t("remote.settings.removeTitle")}
                  body={t("remote.settings.removeBody")}
                  confirmLabel={t("remote.settings.remove")}
                  onCancel={() => setConfirmRemove(false)}
                  onConfirm={() => {
                    setConfirmRemove(false);
                    void run(() => props.onRemoveProfile(selected.id));
                  }}
                />
              </div>
            ) : null}
          </div>
        )}
      </SettingsPage>
    </>
  );
}

function statusKey(status: RemoteProfileStatus | undefined): I18nKey {
  return `remote.status.${status?.state ?? "unknown"}` as I18nKey;
}

function checkTone(status: RemoteDoctorReport["checks"][number]["status"]): "success" | "danger" | "warning" | "neutral" {
  if (status === "pass") return "success";
  if (status === "fail") return "danger";
  if (status === "warning") return "warning";
  return "neutral";
}

function checkStatusKey(status: RemoteDoctorReport["checks"][number]["status"]): I18nKey {
  return `remote.doctor.${status}` as I18nKey;
}
