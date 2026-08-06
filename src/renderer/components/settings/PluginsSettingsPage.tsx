import { useState } from "react";
import type { PluginPackageRecord } from "../../../shared/ipc";
import { FolderIcon, PlugIcon, PlusIcon, RefreshIcon, TrashIcon } from "../icons/Icons";
import { Button, EmptyState, IconButton, Switch, TextInput } from "../ui";
import { getBridge } from "../../desktopApi";
import { useI18n } from "../../i18n";
import { SettingsHeader } from "./SettingsHeader";
import { SettingsList, SettingsListRow, SettingsPage, SettingsToolbar, StatePill } from "./SettingsLayout";

export function PluginsSettingsPage(props: {
  packages: PluginPackageRecord[];
  loading: boolean;
  savingSource: string | null;
  onClose(): void;
  onRefresh(): void;
  onInstall(source: string): Promise<unknown>;
  onUpdate(source: string, scope: PluginPackageRecord["scope"]): Promise<unknown>;
  onRemove(source: string, scope: PluginPackageRecord["scope"]): Promise<unknown>;
  onSetEnabled(source: string, scope: PluginPackageRecord["scope"], enabled: boolean): Promise<unknown>;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState("");
  const [installState, setInstallState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [localError, setLocalError] = useState("");
  const trimmedSource = source.trim();
  const installing = props.savingSource === "new" || installState === "saving";

  async function install() {
    if (!trimmedSource) {
      setLocalError(t("settings.plugins.sourceRequired"));
      setInstallState("failed");
      return;
    }
    setLocalError("");
    setInstallState("saving");
    const result = await props.onInstall(trimmedSource);
    setInstallState(result ? "saved" : "failed");
    if (result) setSource("");
  }

  async function chooseLocalFolder() {
    try {
      const picked = await getBridge().pickFolder(t("settings.plugins.chooseFolderTitle"));
      if (!picked) return;
      setSource(picked.path);
      setLocalError("");
      setInstallState("idle");
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : t("app.saveFailed"));
      setInstallState("failed");
    }
  }

  return (
    <>
      <SettingsHeader title={t("settings.plugins.title")} />
      <SettingsPage className="plugins-settings-page">
        <SettingsToolbar className="plugins-toolbar">
          <TextInput
            aria-label={t("settings.plugins.sourceAria")}
            value={source}
            placeholder={t("settings.plugins.sourcePlaceholder")}
            disabled={installing}
            onChange={(event) => {
              setSource(event.target.value);
              setLocalError("");
              setInstallState("idle");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void install();
            }}
          />
          <Button size="sm" leftIcon={<PlusIcon />} loading={installing} disabled={!trimmedSource} onClick={() => void install()}>
            {installing ? t("settings.plugins.installing") : t("settings.plugins.install")}
          </Button>
          <Button size="sm" variant="quiet" leftIcon={<FolderIcon />} disabled={installing} onClick={() => void chooseLocalFolder()}>
            {t("settings.plugins.chooseFolder")}
          </Button>
          <IconButton label={t("app.refresh")} size="sm" disabled={props.loading} onClick={props.onRefresh}>
            <RefreshIcon />
          </IconButton>
        </SettingsToolbar>
        <div className="plugins-install-state" aria-live="polite">
          {installState === "saved" ? <StatePill tone="success">{t("settings.plugins.installed")}</StatePill> : null}
          {installState === "failed" ? <StatePill tone="danger">{localError || t("app.saveFailed")}</StatePill> : null}
        </div>
        <SettingsList className="plugins-list" ariaLabel={t("settings.plugins.list")}>
          {props.packages.length === 0 ? (
            <EmptyState icon={<PlugIcon />} title={t("settings.plugins.empty")} />
          ) : props.packages.map((plugin) => (
            <PluginPackageRow
              key={`${plugin.scope}:${plugin.source}`}
              plugin={plugin}
              saving={props.savingSource === plugin.source}
              onUpdate={() => props.onUpdate(plugin.source, plugin.scope)}
              onRemove={() => props.onRemove(plugin.source, plugin.scope)}
              onSetEnabled={(enabled) => props.onSetEnabled(plugin.source, plugin.scope, enabled)}
            />
          ))}
        </SettingsList>
      </SettingsPage>
    </>
  );
}

function PluginPackageRow(props: {
  plugin: PluginPackageRecord;
  saving: boolean;
  onUpdate(): Promise<unknown>;
  onRemove(): Promise<unknown>;
  onSetEnabled(enabled: boolean): Promise<unknown>;
}) {
  const { t } = useI18n();
  const counts = formatCounts(props.plugin);
  const statusTone = props.plugin.enabled ? "success" : "neutral";
  return (
    <SettingsListRow
      className={`plugin-row ${props.plugin.enabled ? "enabled" : ""}`}
      icon={<PlugIcon />}
      title={props.plugin.displayName}
      description={props.plugin.source}
      meta={[
        t("settings.plugins.scope", { scope: props.plugin.scope }),
        counts,
        props.plugin.installedPath ? t("settings.plugins.path", { path: props.plugin.installedPath }) : ""
      ].filter(Boolean).join(" | ")}
      status={
        <StatePill tone={statusTone}>
          {props.saving ? t("app.saving") : props.plugin.enabled ? t("app.enabled") : t("app.disabled")}
        </StatePill>
      }
      actions={
        <div className="plugin-row-actions">
          <Switch
            checked={props.plugin.enabled}
            disabled={props.saving}
            aria-label={props.plugin.enabled ? t("settings.plugins.disablePackage", { name: props.plugin.displayName }) : t("settings.plugins.enablePackage", { name: props.plugin.displayName })}
            onChange={(enabled) => void props.onSetEnabled(enabled)}
          />
          <Button size="sm" disabled={props.saving || !props.plugin.updateable} loading={props.saving && props.plugin.updateable} onClick={() => void props.onUpdate()}>
            {t("settings.plugins.update")}
          </Button>
          <IconButton
            label={t("settings.plugins.removePackage", { name: props.plugin.displayName })}
            variant="danger"
            size="sm"
            disabled={props.saving || !props.plugin.removable}
            onClick={() => void props.onRemove()}
          >
            <TrashIcon />
          </IconButton>
        </div>
      }
    />
  );
}

function formatCounts(plugin: PluginPackageRecord): string {
  return [
    `ext ${countText(plugin.resourceCounts.extensions)}`,
    `skills ${countText(plugin.resourceCounts.skills)}`,
    `prompts ${countText(plugin.resourceCounts.prompts)}`,
    `themes ${countText(plugin.resourceCounts.themes)}`
  ].join(" / ");
}

function countText(count: { enabled: number; total: number }): string {
  return count.total === count.enabled ? String(count.total) : `${count.enabled}/${count.total}`;
}
