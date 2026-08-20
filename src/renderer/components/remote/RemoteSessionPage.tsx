import { useEffect, useRef, useState } from "react";
import type {
  AppLanguage,
  RemoteProfileStatus,
  RemoteProfileSummary,
  RemoteSessionSummary,
  RemoteSessionTranscript,
  RemoteWorkspace
} from "../../../shared/ipc";
import { localeTag, useI18n, type I18nKey } from "../../i18n";
import { RefreshIcon, ServerIcon } from "../icons/Icons";
import { Button, EmptyState, LoadingDots, StatusPill } from "../ui";
import { sessionStateKey, statusLabelKey, statusTone } from "./RemoteTree";

export type RemoteSessionPageProps = {
  profile: RemoteProfileSummary | null;
  workspace: RemoteWorkspace | null;
  cwd: string;
  status: RemoteProfileStatus | undefined;
  sessions: RemoteSessionSummary[];
  activeSessionId: string | null;
  refreshing: boolean;
  onRefresh(): void;
  onSelectSession(sessionId: string): void;
  onOpenSession(sessionId: string, options?: { refetch?: boolean }): Promise<RemoteSessionTranscript | null>;
};

/**
 * The workspace view and the reader are one page: the list on the left states
 * what each session costs to open, and the panel on the right is what opening it
 * produced. A session that is already cached renders with no network at all.
 */
export function RemoteSessionPage(props: RemoteSessionPageProps) {
  const { t, language } = useI18n();
  const [transcript, setTranscript] = useState<RemoteSessionTranscript | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const activeSessionId = props.activeSessionId;
  useEffect(() => {
    if (!activeSessionId) {
      setTranscript(null);
      return;
    }
    let cancelled = false;
    const request = ++requestRef.current;
    setLoadingSessionId(activeSessionId);
    // The previous session's transcript goes as soon as another row is picked.
    // Keeping it would leave the reader showing one session under another row's
    // selection for as long as the next read takes.
    setTranscript(null);
    void props.onOpenSession(activeSessionId).then((result) => {
      // A slower earlier open must not overwrite the session now selected.
      if (cancelled || request !== requestRef.current) return;
      setTranscript(result);
      setLoadingSessionId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, props.profile?.id]);

  async function refetch() {
    if (!activeSessionId) return;
    const request = ++requestRef.current;
    setLoadingSessionId(activeSessionId);
    const result = await props.onOpenSession(activeSessionId, { refetch: true });
    if (request !== requestRef.current) return;
    setTranscript(result);
    setLoadingSessionId(null);
  }

  if (!props.profile) {
    return (
      <div className="remote-page">
        <EmptyState icon={<ServerIcon />} title={t("remote.empty")} subtitle={t("remote.settings.noProfiles")} />
      </div>
    );
  }

  const workspaceName = props.workspace?.name ?? props.cwd;
  return (
    <div className="remote-page">
      <header className="remote-page-header">
        <div className="remote-page-heading">
          <h2>{workspaceName}</h2>
          <p title={props.cwd}>{props.profile.name} · {props.cwd}</p>
        </div>
        <div className="remote-page-header-actions">
          <StatusPill tone={statusPillTone(props.status)}>{t(statusLabelKey(props.status))}</StatusPill>
          <Button
            variant="ghost"
            disabled={props.refreshing}
            loading={props.refreshing}
            onClick={props.onRefresh}
            aria-label={t("remote.refreshSessions")}
          >
            <RefreshIcon />
            <span>{t("remote.refreshSessions")}</span>
          </Button>
        </div>
      </header>

      {props.status?.state === "disconnected" ? (
        <p className="remote-page-note">{t("remote.status.disconnectedDetail")}</p>
      ) : null}
      {props.status?.state === "failed" && props.status.message ? (
        <p className="remote-page-note danger">
          {props.status.message}
          {props.status.remediation ? ` ${props.status.remediation}` : ""}
        </p>
      ) : null}

      <div className="remote-page-body">
        <div className="remote-session-list" aria-label={t("remote.settings.workspaces")}>
          {props.sessions.length === 0 ? (
            <p className="remote-empty-row">{t("remote.noSessions")}</p>
          ) : props.sessions.map((session) => (
            <button
              className={`remote-session-card ${session.sessionId === activeSessionId ? "active" : ""} ${session.state}`}
              key={session.sessionId}
              type="button"
              aria-current={session.sessionId === activeSessionId ? "true" : undefined}
              aria-label={t("remote.session.open", { title: session.title })}
              onClick={() => props.onSelectSession(session.sessionId)}
            >
              <span className="remote-session-card-title">{session.title}</span>
              <span className="remote-session-card-meta">
                <span className={`remote-session-state ${session.state}`} aria-hidden="true" />
                <small>{t(sessionStateKey(session.state))}</small>
                {session.turnCount ? <small>{t("remote.session.turns", { count: session.turnCount })}</small> : null}
                <small>{formatTimestamp(session.remoteUpdatedAt ?? session.remoteCreatedAt, language)}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="remote-transcript" aria-live="polite">
          {!activeSessionId ? (
            <EmptyState
              icon={<ServerIcon />}
              title={workspaceName}
              subtitle={t("remote.session.count", { count: props.sessions.length })}
            />
          ) : !transcript || transcript.sessionId !== activeSessionId ? (
            // Belt and braces with the clear above: a transcript is only ever
            // drawn under the row it belongs to.
            <p className="remote-transcript-status"><LoadingDots /> {t("remote.session.loading")}</p>
          ) : (
            <>
              <div className="remote-transcript-header">
                <h3>{transcript.title}</h3>
                <div className="remote-transcript-sync">
                  <small>{syncSummary(transcript, t, language)}</small>
                  <Button variant="ghost" onClick={() => void refetch()} disabled={transcript.state === "gone" || loadingSessionId === activeSessionId}>
                    {t("remote.session.refetch")}
                  </Button>
                </div>
              </div>
              {transcript.state === "gone" ? <p className="remote-page-note">{t("remote.session.goneNotice")}</p> : null}
              {transcript.refetched ? <p className="remote-page-note">{t("remote.session.refetched")}</p> : null}
              {transcript.omittedEntryCount > 0 ? (
                <p className="remote-transcript-omitted">{t("remote.session.omitted", { count: transcript.omittedEntryCount })}</p>
              ) : null}
              {transcript.entries.length === 0 ? (
                <p className="remote-transcript-status">{t("remote.session.emptyTranscript")}</p>
              ) : transcript.entries.map((item) => (
                <article className={`remote-entry ${item.kind} ${item.appended ? "appended" : ""}`} key={item.id}>
                  <header>
                    <span className="remote-entry-kind">{t(entryKindKey(item.kind))}</span>
                    {item.toolName ? <span className="remote-entry-tool">{item.toolName}</span> : null}
                    {item.appended ? <StatusPill tone="accent">{t("remote.session.appended")}</StatusPill> : null}
                    {item.timestamp ? <time dateTime={item.timestamp}>{formatTimestamp(item.timestamp, language)}</time> : null}
                  </header>
                  <p>{item.text}</p>
                </article>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function entryKindKey(kind: RemoteSessionTranscript["entries"][number]["kind"]): I18nKey {
  return `remote.session.entry.${kind}` as I18nKey;
}

function statusPillTone(status: RemoteProfileStatus | undefined): "neutral" | "success" | "danger" | "accent" | "warning" {
  const tone = statusTone(status);
  if (tone === "ready") return "success";
  if (tone === "failed") return "danger";
  if (tone === "attention") return "warning";
  if (tone === "checking") return "accent";
  return "neutral";
}

function syncSummary(transcript: RemoteSessionTranscript, t: (key: I18nKey, values?: Record<string, string | number>) => string, language: AppLanguage): string {
  if (transcript.fetchedBytes > 0) return t("remote.session.fetched", { size: formatBytes(transcript.fetchedBytes) });
  if (transcript.syncedAt) return t("remote.session.syncedAt", { time: formatTimestamp(transcript.syncedAt, language) });
  return t("remote.session.upToDate");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Dates read in the language the app is set to, never the machine's locale.
function formatTimestamp(iso: string | null, language: AppLanguage): string {
  if (!iso) return "";
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  return value.toLocaleString(localeTag(language), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
