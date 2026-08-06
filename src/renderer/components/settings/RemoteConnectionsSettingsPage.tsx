import { useState } from "react";
import type { RemoteConnectionCreateRequest, RemoteConnectionRecord, RemoteConnectionUpdateRequest } from "../../../shared/ipc";
import { PlugIcon, PlusIcon, RefreshIcon, TerminalIcon, TrashIcon } from "../icons/Icons";
import { SettingsHeader } from "./SettingsHeader";
import { useI18n } from "../../i18n";
import { Button, Dialog, EmptyState, IconButton, Tabs, TextInput } from "../ui";
import { SettingsList, SettingsListRow, SettingsPage, SettingsToolbar } from "./SettingsLayout";

export function RemoteConnectionsSettingsPage(props: {
  connections: RemoteConnectionRecord[];
  loading: boolean;
  savingId: string | null;
  onClose(): void;
  onRefresh(): void;
  onImport(): void;
  onCreate(request: RemoteConnectionCreateRequest): Promise<RemoteConnectionRecord | null>;
  onUpdate(request: RemoteConnectionUpdateRequest): Promise<RemoteConnectionRecord | null>;
  onDelete(id: string): void;
  onTest(id: string): void;
}) {
  const { t } = useI18n();
  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <>
      <SettingsHeader title={t("settings.remote.title")} />
      <SettingsPage className="remote-settings-shell" title={t("settings.remote.title")}>
        <SettingsToolbar className="remote-tabs-bar remote-actions">
          <Tabs ariaLabel={t("settings.remote.title")} className="remote-tabs" value="ssh" onChange={() => undefined} tabs={[{ id: "ssh", label: "SSH" }]} />
          <span className="ui-toolbar-spacer" />
          <Button size="sm" disabled={props.savingId === "import"} loading={props.savingId === "import"} onClick={props.onImport} leftIcon={<PlugIcon />}>
            {props.savingId === "import" ? t("settings.remote.importing") : t("settings.remote.import")}
          </Button>
          <Button size="sm" onClick={() => setEditorOpen(true)} leftIcon={<PlusIcon />}>
            {t("settings.remote.add")}
          </Button>
          <IconButton label={t("settings.remote.refresh")} size="sm" onClick={props.onRefresh} disabled={props.loading}>
            <RefreshIcon />
          </IconButton>
        </SettingsToolbar>

        <SettingsList className="remote-list" ariaLabel={t("settings.remote.list")}>
          {props.connections.length === 0 ? (
            <EmptyState icon={<TerminalIcon />} title={t("settings.remote.empty")} />
          ) : props.connections.map((connection) => (
            <RemoteConnectionRow
              key={connection.id}
              connection={connection}
              saving={props.savingId === connection.id}
              labels={{
                active: t("settings.remote.active"),
                use: t("settings.remote.use"),
                local: t("settings.remote.local"),
                test: t("settings.remote.test"),
                testing: t("settings.remote.testing"),
                remove: t("settings.remote.remove"),
                connected: t("settings.remote.connected"),
                failed: t("settings.remote.failed"),
                unchecked: t("settings.remote.unchecked")
              }}
              onUse={() => void props.onUpdate({ id: connection.id, active: !connection.active })}
              onTest={() => props.onTest(connection.id)}
              onDelete={() => props.onDelete(connection.id)}
            />
          ))}
        </SettingsList>
      </SettingsPage>

      {editorOpen && (
        <RemoteConnectionEditor
          saving={props.savingId === "new"}
          onCancel={() => setEditorOpen(false)}
          onSave={async (request) => {
            const connection = await props.onCreate(request);
            if (connection) setEditorOpen(false);
          }}
        />
      )}
    </>
  );
}

function RemoteConnectionRow(props: {
  connection: RemoteConnectionRecord;
  saving: boolean;
  labels: Record<"active" | "use" | "local" | "test" | "testing" | "remove" | "connected" | "failed" | "unchecked", string>;
  onUse(): void;
  onTest(): void;
  onDelete(): void;
}) {
  const statusLabel = props.connection.status === "connected" ? props.labels.connected : props.connection.status === "failed" ? props.labels.failed : props.labels.unchecked;
  return (
    <SettingsListRow
      className={`remote-row ${props.connection.active ? "selected" : ""}`}
      icon={<TerminalIcon />}
      title={props.connection.name}
      description={remoteTarget(props.connection)}
      meta={`${props.connection.remotePath ?? props.labels.local}${props.connection.lastError ? ` - ${props.connection.lastError}` : ""}`}
      status={<span className={`remote-status ${props.connection.active ? "active" : props.connection.status}`}>{props.connection.active ? props.labels.active : statusLabel}</span>}
      actions={
        <>
          <Button size="sm" disabled={props.saving || props.connection.active} onClick={props.onUse}>
            {props.connection.active ? props.labels.active : props.labels.use}
          </Button>
          <Button size="sm" disabled={props.saving} loading={props.saving} onClick={props.onTest}>
            {props.saving ? props.labels.testing : props.labels.test}
          </Button>
          <IconButton label={props.labels.remove} variant="danger" size="sm" onClick={props.onDelete} disabled={props.saving}>
            <TrashIcon />
          </IconButton>
        </>
      }
    />
  );
}

function RemoteConnectionEditor(props: {
  saving: boolean;
  onCancel(): void;
  onSave(request: RemoteConnectionCreateRequest): Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState({ name: "", host: "", user: "", port: "", remotePath: "" });
  const [error, setError] = useState("");

  async function save() {
    if (!draft.name.trim() || !draft.host.trim()) {
      setError(t("settings.remote.required"));
      return;
    }
    const port = draft.port.trim() ? Number(draft.port.trim()) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setError(t("settings.remote.invalidPort"));
      return;
    }
    await props.onSave({
      name: draft.name,
      host: draft.host,
      user: draft.user || undefined,
      port,
      remotePath: draft.remotePath || undefined,
      source: "manual"
    });
  }

  return (
    <Dialog
      open
      title={t("settings.remote.manualTitle")}
      className="remote-editor"
      closeLabel={t("app.close")}
      onClose={props.onCancel}
      actions={
        <>
          <span className={`save-state ${error ? "failed" : ""}`}>{error}</span>
          <Button variant="ghost" onClick={props.onCancel}>{t("app.cancel")}</Button>
          <Button variant="primary" disabled={props.saving} loading={props.saving} onClick={() => void save()}>
            {props.saving ? t("app.savingDots") : t("settings.remote.save")}
          </Button>
        </>
      }
    >
      <div className="ui-form-grid" aria-label={t("settings.remote.manualTitle")}>
        <label>
          <span>{t("settings.remote.name")}</span>
          <TextInput aria-label={t("settings.remote.name")} value={draft.name} onChange={(event) => { setError(""); setDraft((current) => ({ ...current, name: event.target.value })); }} />
        </label>
        <label>
          <span>{t("settings.remote.host")}</span>
          <TextInput aria-label={t("settings.remote.host")} value={draft.host} placeholder="example.com" onChange={(event) => { setError(""); setDraft((current) => ({ ...current, host: event.target.value })); }} />
        </label>
        <label>
          <span>{t("settings.remote.user")}</span>
          <TextInput aria-label={t("settings.remote.user")} value={draft.user} onChange={(event) => setDraft((current) => ({ ...current, user: event.target.value }))} />
        </label>
        <label>
          <span>{t("settings.remote.port")}</span>
          <TextInput aria-label={t("settings.remote.port")} value={draft.port} inputMode="numeric" placeholder="22" onChange={(event) => { setError(""); setDraft((current) => ({ ...current, port: event.target.value })); }} />
        </label>
        <label>
          <span>{t("settings.remote.path")}</span>
          <TextInput aria-label={t("settings.remote.path")} value={draft.remotePath} placeholder="/home/user/project" onChange={(event) => setDraft((current) => ({ ...current, remotePath: event.target.value }))} />
        </label>
      </div>
    </Dialog>
  );
}

function remoteTarget(connection: RemoteConnectionRecord): string {
  if (connection.configHost) return connection.configHost;
  return `${connection.user ? `${connection.user}@` : ""}${connection.host}${connection.port ? `:${connection.port}` : ""}`;
}
