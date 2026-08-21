import { useEffect, useState } from "react";
import type { RemoteDirectoryListing, RemoteProfileSummary, RemoteWorkspace, RemoteWorkspaceAddRequest } from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";
import { useI18n } from "../../i18n";
import { errorMessage } from "../../utils/errors";
import { FolderIcon } from "../icons/Icons";
import { Button, Dialog, LoadingDots, StatusPill, Switch, TextInput } from "../ui";

/**
 * A workspace is a directory on the remote host, so the picker browses the host
 * rather than asking the user to type a path they cannot verify. Browsing runs
 * over plain SSH, so it works before the managed runtime is installed.
 */
export function AddRemoteWorkspaceDialog(props: {
  open: boolean;
  profile: RemoteProfileSummary | null;
  onClose(): void;
  /** Resolves with the workspace, or with nothing when the add was refused. */
  onAdd(request: RemoteWorkspaceAddRequest): Promise<RemoteWorkspace | null>;
}) {
  const { t } = useI18n();
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null);
  const [path, setPath] = useState<string>("/");
  const [name, setName] = useState("");
  const [setDefault, setSetDefault] = useState(false);
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const profileId = props.profile?.id ?? null;
  useEffect(() => {
    if (!props.open || !profileId) return;
    const initial = props.profile?.defaultCwd ?? "/";
    setPath(initial);
    setName("");
    setSetDefault(false);
    void browse(profileId, initial);
  }, [props.open, profileId]);

  async function browse(id: string, target: string) {
    setLoading(true);
    setBrowseError(null);
    try {
      const result = await getBridge().listRemoteDirectory({ profileId: id, path: target });
      setListing(result);
      setPath(result.path);
    } catch (caught) {
      setListing(null);
      setBrowseError(errorMessage(caught, t("remote.workspace.loading")));
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    if (!profileId) return;
    setSubmitting(true);
    try {
      // A rejected add resolves with nothing rather than throwing, so closing
      // unconditionally would throw away the path and name the user typed for a
      // workspace that was never created.
      const added = await props.onAdd({
        profileId,
        cwd: path,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(setDefault ? { setDefault: true } : {})
      });
      if (added) props.onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t("remote.workspace.title")}
      className="remote-workspace-dialog"
      actions={
        <>
          <Button variant="ghost" onClick={props.onClose}>{t("app.cancel")}</Button>
          <Button variant="primary" loading={submitting} disabled={submitting || !profileId} onClick={() => void submit()}>
            {t("remote.workspace.add")}
          </Button>
        </>
      }
    >
      <div className="remote-browser">
        <label className="remote-browser-path">
          <span>{t("remote.workspace.path")}</span>
          <TextInput
            value={path}
            aria-label={t("remote.workspace.path")}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !profileId) return;
              event.preventDefault();
              void browse(profileId, path);
            }}
          />
        </label>

        <div className="remote-browser-list">
          {listing?.parentPath !== null && listing?.parentPath !== undefined ? (
            <button
              className="remote-browser-row"
              type="button"
              onClick={() => profileId && void browse(profileId, listing.parentPath as string)}
            >
              <FolderIcon />
              <span>{t("remote.workspace.parent")}</span>
            </button>
          ) : null}

          {loading ? (
            <p className="remote-browser-status"><LoadingDots /> {t("remote.workspace.loading")}</p>
          ) : browseError ? (
            <p className="remote-browser-status danger">{browseError}</p>
          ) : listing && listing.entries.length === 0 ? (
            <p className="remote-browser-status">{t("remote.workspace.empty")}</p>
          ) : (listing?.entries ?? []).map((entry) => (
            <button
              className="remote-browser-row"
              key={entry.path}
              type="button"
              aria-label={t("remote.workspace.openDirectory", { name: entry.name })}
              onClick={() => profileId && void browse(profileId, entry.path)}
            >
              <FolderIcon />
              <span className="remote-browser-name">{entry.name}</span>
              {entry.inUse ? <StatusPill tone="accent">{t("remote.workspace.inUse")}</StatusPill> : null}
              {entry.gitRepository ? <StatusPill tone="neutral">{t("remote.workspace.gitRepository")}</StatusPill> : null}
              {entry.writable ? null : <StatusPill tone="warning">{t("remote.workspace.notWritable")}</StatusPill>}
            </button>
          ))}
          {listing?.truncated ? (
            <p className="remote-browser-status">{t("remote.workspace.truncated", { count: listing.entries.length })}</p>
          ) : null}
        </div>

        <label className="remote-browser-field">
          <span>{t("remote.workspace.name")}</span>
          <TextInput
            value={name}
            aria-label={t("remote.workspace.name")}
            placeholder={t("remote.workspace.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <div className="remote-browser-field switch">
          <span>{t("remote.workspace.setDefault")}</span>
          <Switch
            checked={setDefault}
            aria-label={t("remote.workspace.setDefault")}
            onChange={setSetDefault}
          />
        </div>
      </div>
    </Dialog>
  );
}
