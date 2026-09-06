import { useEffect, useRef, useState } from "react";
import type {
  AiProvider,
  AppLanguage,
  ReasoningEffort,
  RemoteLiveTurn,
  RemoteModelSelectionRequest,
  RemoteProfileStatus,
  RemoteProfileSummary,
  RemoteSessionSummary,
  RemoteSessionStartResult,
  RemoteSessionSubmissionPending,
  RemoteSessionTranscript,
  RemoteWorkspace
} from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";
import { localeTag, useI18n, type I18nKey } from "../../i18n";
import { MarkdownMessage } from "../chat/MarkdownMessage";
import { ModelMenu } from "../chat/ModelMenu";
import { ChevronDownIcon, PlusIcon, RefreshIcon, SendIcon, ServerIcon, StopIcon } from "../icons/Icons";
import { Button, EmptyState, LoadingDots, StatusPill, TextArea } from "../ui";
import { sessionStateKey, statusLabelKey, statusTone } from "./RemoteTree";

export type RemoteSessionPageProps = {
  profile: RemoteProfileSummary | null;
  workspace: RemoteWorkspace | null;
  cwd: string;
  status: RemoteProfileStatus | undefined;
  sessions: RemoteSessionSummary[];
  activeSessionId: string | null;
  recoveredCompletion?: { version: number; sessionId: string | null };
  /** What the running turn has produced so far; null when nothing is running. */
  liveTurn?: RemoteLiveTurn | null;
  /** The last prompt failure for this profile, shown in place until the next attempt. */
  submissionError?: string | null;
  onDismissSubmissionError?(): void;
  refreshing: boolean;
  /** Model controls mirror the chat composer: the same providers, selection, and effort. */
  providers?: AiProvider[];
  activeProvider?: AiProvider | null;
  reasoningEffort?: ReasoningEffort;
  onSelectModel?(providerId: string, modelId: string): void;
  onSelectReasoningEffort?(effort: ReasoningEffort): void;
  onOpenProviderSettings?(): void;
  onRefresh(): void;
  onSelectSession(sessionId: string): void;
  onOpenSession(sessionId: string, options?: { refetch?: boolean }): Promise<RemoteSessionTranscript | null>;
  onBeginSession(): void;
  onStartSession(text: string, selection: RemoteModelSelectionRequest): Promise<RemoteSessionStartResult | RemoteSessionSubmissionPending | null>;
  onPromptSession(sessionId: string, text: string, selection: RemoteModelSelectionRequest): Promise<RemoteSessionTranscript | RemoteSessionSubmissionPending | null>;
  onAbortSession(sessionId?: string): Promise<boolean>;
};

/**
 * The workspace view and the reader are one page: the list on the left states
 * what each session costs to open, and the panel on the right is what opening it
 * produced. A session that is already cached renders with no network at all.
 * While a prompt runs, the panel also shows what Pi is producing as it happens,
 * assembled in the main process from the RPC stream; the reconciled transcript
 * takes over once the turn settles.
 */
export function RemoteSessionPage(props: RemoteSessionPageProps) {
  const { t, language } = useI18n();
  const [transcript, setTranscript] = useState<RemoteSessionTranscript | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [failedSessionId, setFailedSessionId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [sendingSessionId, setSendingSessionId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [optimisticPrompt, setOptimisticPrompt] = useState<{ sessionId: string | null; text: string } | null>(null);
  const [pendingStartSessionId, setPendingStartSessionId] = useState<string | null>(null);
  const [pendingExistingSession, setPendingExistingSession] = useState<{
    sessionId: string;
    sessionsAtSubmit: RemoteSessionSummary[];
  } | null>(null);
  const requestRef = useRef(0);
  const promptRequestRef = useRef(0);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const recoveredCompletionVersionRef = useRef(props.recoveredCompletion?.version ?? 0);
  const activeSessionRef = useRef(props.activeSessionId);
  activeSessionRef.current = props.activeSessionId;
  const sessionOperation = props.status?.sessionOperation?.cwd === props.cwd ? props.status.sessionOperation : null;
  const operationRunning = starting || Boolean(sendingSessionId) || Boolean(sessionOperation);
  const providers = props.providers ?? [];
  const activeProvider = props.activeProvider ?? null;
  const reasoningEffort = props.reasoningEffort ?? "off";
  const modelSelection: RemoteModelSelectionRequest = {
    ...(activeProvider ? { providerId: activeProvider.id, modelId: activeProvider.defaultModel } : {}),
    reasoningEffort
  };
  const activeSessionId = props.activeSessionId;
  // The live turn is drawn only under the session it belongs to: a turn running
  // in another workspace, or in another session of this one, is not this view's.
  const liveTurn = props.liveTurn
    && props.liveTurn.cwd === props.cwd
    && (activeSessionId === null || props.liveTurn.sessionId === activeSessionId)
    ? props.liveTurn
    : null;
  const showLive = Boolean(liveTurn) && operationRunning;

  useEffect(() => {
    promptRequestRef.current += 1;
    setDrafting(false);
    setDraft("");
    setOptimisticPrompt(null);
    setStarting(false);
    setSendingSessionId(null);
    setStopping(false);
    setModelMenuOpen(false);
    setPendingStartSessionId(null);
    setPendingExistingSession(null);
    recoveredCompletionVersionRef.current = props.recoveredCompletion?.version ?? 0;
    return () => { promptRequestRef.current += 1; };
  }, [props.profile?.id, props.cwd]);

  useEffect(() => {
    if (!sessionOperation) setStopping(false);
  }, [sessionOperation]);

  useEffect(() => {
    if (!activeSessionId) {
      setTranscript(null);
      setFailedSessionId(null);
      return;
    }
    setDrafting(false);
    let cancelled = false;
    const request = ++requestRef.current;
    setLoadingSessionId(activeSessionId);
    setFailedSessionId(null);
    // The previous session's transcript goes as soon as another row is picked.
    // Keeping it would leave the reader showing one session under another row's
    // selection for as long as the next read takes.
    setTranscript(null);
    void props.onOpenSession(activeSessionId).then((result) => {
      // A slower earlier open must not overwrite the session now selected.
      if (cancelled || request !== requestRef.current) return;
      setTranscript(result);
      // A failed open resolves with nothing, so without this the reader would
      // sit on "Opening the session" forever instead of offering a retry.
      setFailedSessionId(result ? null : activeSessionId);
      setLoadingSessionId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, props.profile?.id, reloadToken]);

  useEffect(() => {
    if (!pendingStartSessionId || !props.sessions.some((session) => session.sessionId === pendingStartSessionId)) return;
    setPendingStartSessionId(null);
    props.onSelectSession(pendingStartSessionId);
  }, [pendingStartSessionId, props.sessions]);

  useEffect(() => {
    if (!pendingExistingSession || sessionOperation) return;
    if (props.sessions === pendingExistingSession.sessionsAtSubmit) return;
    if (activeSessionId !== pendingExistingSession.sessionId) {
      setPendingExistingSession(null);
      return;
    }
    setPendingExistingSession(null);
    void refetch();
  }, [pendingExistingSession, props.sessions, sessionOperation, activeSessionId]);

  useEffect(() => {
    const completion = props.recoveredCompletion;
    if (!completion || completion.version <= recoveredCompletionVersionRef.current) return;
    recoveredCompletionVersionRef.current = completion.version;
    if (!activeSessionId || (completion.sessionId && completion.sessionId !== activeSessionId)) return;
    void refetch();
  }, [props.recoveredCompletion?.version, activeSessionId]);

  // Live output grows at the bottom; keep it in view while the turn runs so the
  // reader follows what Pi is doing without scrolling after every token.
  useEffect(() => {
    if (!showLive) return;
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [showLive, liveTurn?.version]);

  async function refetch() {
    if (!activeSessionId) return;
    const request = ++requestRef.current;
    setLoadingSessionId(activeSessionId);
    setFailedSessionId(null);
    const result = await props.onOpenSession(activeSessionId, { refetch: true });
    if (request !== requestRef.current) return;
    setTranscript(result);
    setFailedSessionId(result ? null : activeSessionId);
    setLoadingSessionId(null);
  }

  function beginSession() {
    if (operationRunning) return;
    setStopping(false);
    setDrafting(true);
    setTranscript(null);
    setFailedSessionId(null);
    props.onBeginSession();
  }

  async function sendPrompt() {
    const sessionId = activeSessionRef.current;
    const sessionsAtSubmit = props.sessions;
    const text = draft.trim();
    if (!text || operationRunning || !drafting && !sessionId) return;
    const request = ++promptRequestRef.current;
    setDraft("");
    setOptimisticPrompt({ sessionId: drafting ? null : sessionId, text });
    if (drafting) setStarting(true);
    else setSendingSessionId(sessionId);
    const started = drafting ? await props.onStartSession(text, modelSelection) : null;
    const prompted = drafting ? null : await props.onPromptSession(sessionId!, text, modelSelection);
    const submission = drafting ? started : prompted;
    const pending = isSubmissionPending(submission);
    const result: RemoteSessionTranscript | null = drafting
      ? started && !isSubmissionPending(started) ? started.transcript : null
      : prompted && !isSubmissionPending(prompted) ? prompted : null;
    if (request !== promptRequestRef.current) return;
    if (result && activeSessionRef.current === sessionId) setTranscript(result);
    if (started && !isSubmissionPending(started) && activeSessionRef.current === null) {
      setTranscript(started.transcript);
      setDrafting(false);
      props.onSelectSession(started.session.sessionId);
    }
    if (drafting && pending) {
      setDrafting(false);
      setPendingStartSessionId(isSubmissionPending(started) ? started.sessionId : null);
    }
    if (!drafting && pending && sessionId) {
      setPendingExistingSession({ sessionId, sessionsAtSubmit });
    }
    if (!submission) setDraft(text);
    setOptimisticPrompt(null);
    setStarting(false);
    setSendingSessionId(null);
    setStopping(false);
  }

  async function stopPrompt() {
    if (!operationRunning || stopping) return;
    setStopping(true);
    const stopped = await props.onAbortSession(starting ? undefined : sendingSessionId ?? sessionOperation?.sessionId ?? undefined);
    if (!stopped) setStopping(false);
  }

  if (!props.profile) {
    return (
      <div className="remote-page">
        <EmptyState icon={<ServerIcon />} title={t("remote.empty")} subtitle={t("remote.settings.noProfiles")} />
      </div>
    );
  }

  const workspaceName = props.workspace?.name ?? props.cwd;
  const runningLabel = sessionOperation?.state === "reconnecting" ? t("remote.session.reconnecting") : t("remote.session.running");
  const composerVisible = drafting || activeSessionId && transcript?.state !== "gone";
  const canSend = Boolean(draft.trim());
  const liveEntries = showLive && liveTurn ? liveTurn.entries : [];
  // An empty string is still a failure -- Pi recorded no message for it.
  const liveError = showLive && liveTurn ? liveTurn.error : null;

  return (
    <div className="remote-page">
      <header className="remote-page-header">
        <div className="remote-page-heading">
          <h2>{workspaceName}</h2>
          <p title={props.cwd}>{props.profile.name} · {props.cwd}</p>
        </div>
        <div className="remote-page-header-actions">
          <Button variant="primary" disabled={drafting || operationRunning} leftIcon={<PlusIcon />} onClick={beginSession}>
            {t("remote.session.new")}
          </Button>
          {sessionOperation && !starting && !sendingSessionId && !activeSessionId && !drafting ? (
            <>
              <span className="remote-transcript-status"><LoadingDots /> {runningLabel}</span>
              <Button variant="danger" loading={stopping || sessionOperation.state === "stopping"} disabled={stopping} leftIcon={<StopIcon />} onClick={() => void stopPrompt()}>
                {t("remote.session.stop")}
              </Button>
            </>
          ) : null}
          <StatusPill tone={statusPillTone(props.status)}>{t(statusLabelKey(props.status))}</StatusPill>
          <Button
            variant="ghost"
            disabled={props.refreshing}
            loading={props.refreshing}
            leftIcon={<RefreshIcon />}
            onClick={props.onRefresh}
            aria-label={t("remote.refreshSessions")}
          >
            {t("remote.refreshSessions")}
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
            <p className="remote-session-list-empty">{t("remote.noSessions")}</p>
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

        <div className="remote-transcript" aria-live="polite" ref={transcriptRef}>
          {drafting ? (
            <>
              {!optimisticPrompt ? (
                <EmptyState
                  icon={<ServerIcon />}
                  title={t("remote.session.new")}
                  subtitle={t("remote.session.newHint")}
                />
              ) : null}
              {optimisticPrompt?.sessionId === null ? (
                <PendingPromptEntry text={optimisticPrompt.text} />
              ) : null}
              <LiveEntries entries={liveEntries} error={liveError} running={operationRunning} language={language} />
            </>
          ) : !activeSessionId ? (
            <EmptyState
              icon={<ServerIcon />}
              title={workspaceName}
              subtitle={props.sessions.length === 0 ? t("remote.session.newHint") : t("remote.session.pickHint", { count: props.sessions.length })}
              action={<Button variant="primary" disabled={drafting || operationRunning} leftIcon={<PlusIcon />} onClick={beginSession}>{t("remote.session.new")}</Button>}
            />
          ) : failedSessionId === activeSessionId ? (
            <div className="remote-transcript-failure">
              <p className="remote-page-note danger">{t("remote.session.openFailed")}</p>
              <Button onClick={() => setReloadToken((token) => token + 1)}>{t("remote.session.retry")}</Button>
            </div>
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
              {transcript.entries.length === 0 && !optimisticPrompt ? (
                <p className="remote-transcript-status">{t("remote.session.emptyTranscript")}</p>
              ) : transcript.entries.map((item) => (
                <RemoteEntryView
                  key={item.id}
                  kind={item.kind}
                  text={item.text}
                  toolName={item.toolName}
                  toolArgs={item.toolArgs}
                  isError={item.isError}
                  notice={item.notice}
                  timestamp={item.timestamp}
                  appended={item.appended}
                  language={language}
                />
              ))}
              {optimisticPrompt?.sessionId === activeSessionId ? (
                <PendingPromptEntry text={optimisticPrompt.text} />
              ) : null}
              <LiveEntries entries={liveEntries} error={liveError} running={operationRunning} language={language} />
            </>
          )}
        </div>
      </div>

      {props.submissionError ? (
        <div className="remote-page-note danger remote-submission-error" role="alert">
          <span>{props.submissionError}</span>
          {props.onDismissSubmissionError ? (
            <Button variant="ghost" size="sm" onClick={props.onDismissSubmissionError}>{t("remote.session.dismissError")}</Button>
          ) : null}
        </div>
      ) : null}

      {composerVisible ? (
        <div className="remote-composer">
          <TextArea
            value={draft}
            disabled={operationRunning}
            aria-label={t("remote.session.prompt")}
            placeholder={t("remote.session.promptPlaceholder")}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void sendPrompt();
              }
            }}
          />
          <div className="remote-composer-actions">
            <button
              ref={modelTriggerRef}
              className="model-pill remote-model-pill"
              type="button"
              aria-label={t("remote.session.model")}
              aria-expanded={modelMenuOpen}
              title={activeProvider ? t("remote.session.modelHint") : t("model.noProvider")}
              onClick={() => setModelMenuOpen((open) => !open)}
            >
              {activeProvider?.defaultModel ?? t("composer.noProvider")}
              <span>{reasoningEffort}</span>
              <ChevronDownIcon />
            </button>
            <ModelMenu
              open={modelMenuOpen}
              anchorRef={modelTriggerRef}
              provider={activeProvider}
              providers={providers}
              activeProviderId={activeProvider?.id ?? ""}
              testing={false}
              reasoningEffort={reasoningEffort}
              onSelectProvider={(providerId) => {
                const provider = providers.find((candidate) => candidate.id === providerId);
                if (provider) props.onSelectModel?.(provider.id, provider.defaultModel);
                setModelMenuOpen(false);
              }}
              onSelectModel={(providerId, modelId) => {
                props.onSelectModel?.(providerId, modelId);
                setModelMenuOpen(false);
              }}
              onSelectReasoningEffort={(effort) => props.onSelectReasoningEffort?.(effort)}
              onOpenSettings={() => props.onOpenProviderSettings?.()}
              onTest={() => {}}
              onOpenChange={setModelMenuOpen}
            />
            <span className="remote-composer-spacer" />
            {operationRunning ? (
              <>
                <span className="remote-transcript-status"><LoadingDots /> {runningLabel}</span>
                <Button variant="danger" loading={stopping || sessionOperation?.state === "stopping"} disabled={stopping} leftIcon={<StopIcon />} onClick={() => void stopPrompt()}>
                  {t("remote.session.stop")}
                </Button>
              </>
            ) : (
              <Button variant="primary" disabled={!canSend} leftIcon={<SendIcon />} onClick={() => void sendPrompt()}>
                {t("remote.session.send")}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PendingPromptEntry(props: { text: string }) {
  const { t } = useI18n();
  return (
    <article className="remote-entry kind-user pending" aria-label={t("remote.session.sending")}>
      <header><span className="remote-entry-kind">{t("remote.session.entry.user")}</span></header>
      <p className="remote-entry-text">{props.text}</p>
    </article>
  );
}

/** The running turn's blocks, drawn with the same grammar as settled history. */
function LiveEntries(props: { entries: RemoteLiveTurn["entries"]; error: string | null; running: boolean; language: AppLanguage }) {
  const { t } = useI18n();
  const failed = props.error !== null;
  if (props.entries.length === 0 && !failed && !props.running) return null;
  return (
    <div className="remote-live" data-remote-live="true">
      {props.entries.map((entry) => (
        <RemoteEntryView
          key={entry.id}
          kind={entry.kind}
          text={entry.text}
          toolName={entry.toolName}
          toolArgs={entry.toolArgs}
          isError={entry.toolState === "error"}
          timestamp={null}
          appended={false}
          live={props.running}
          toolRunning={entry.toolState === "running"}
          language={props.language}
        />
      ))}
      {failed ? (
        <RemoteEntryView kind="notice" text={props.error ?? ""} toolName={null} toolArgs={null} isError notice="error" timestamp={null} appended={false} language={props.language} />
      ) : null}
      {props.running && props.entries.length === 0 && !failed ? (
        <p className="remote-transcript-status"><LoadingDots /> {t("remote.session.waitingForModel")}</p>
      ) : null}
    </div>
  );
}

type RemoteEntryViewProps = {
  kind: RemoteSessionTranscript["entries"][number]["kind"];
  text: string;
  toolName: string | null;
  toolArgs: string | null;
  isError: boolean;
  notice?: "error" | "aborted" | null;
  timestamp: string | null;
  appended: boolean;
  /** Part of the turn still running: Markdown is rendered in streaming mode. */
  live?: boolean;
  toolRunning?: boolean;
  language: AppLanguage;
};

/**
 * One transcript row. The assistant's text is Markdown, like every answer in
 * the app; thinking and tool output stay behind a disclosure so a long
 * session reads as its conversation, with the work available underneath.
 */
function RemoteEntryView(props: RemoteEntryViewProps) {
  const { t } = useI18n();
  // The kind is namespaced: bare `tool` and `thinking` are classes the chat
  // composer and timeline already own, and a tool row styled as a 31px icon
  // button is what an unprefixed class produced.
  const className = [
    "remote-entry",
    `kind-${props.kind}`,
    props.appended ? "appended" : "",
    props.isError ? "is-error" : "",
    props.live ? "live" : ""
  ].filter(Boolean).join(" ");
  const time = props.timestamp ? <time dateTime={props.timestamp}>{formatTimestamp(props.timestamp, props.language)}</time> : null;

  if (props.kind === "tool") {
    const hasOutput = props.text.trim().length > 0;
    return (
      <article className={className}>
        <header>
          <span className="remote-entry-kind">{t("remote.session.entry.tool")}</span>
          {props.toolName ? <span className="remote-entry-tool">{props.toolName}</span> : null}
          {props.toolArgs ? <code className="remote-entry-args" title={props.toolArgs}>{props.toolArgs}</code> : null}
          {props.toolRunning ? <span className="remote-entry-running"><LoadingDots /></span> : null}
          {props.isError ? <StatusPill tone="danger">{t("remote.session.toolFailed")}</StatusPill> : null}
          {props.appended ? <StatusPill tone="accent">{t("remote.session.appended")}</StatusPill> : null}
          {time}
        </header>
        {hasOutput ? (
          <details className="remote-entry-disclosure" open={props.isError || undefined}>
            <summary>{t("remote.session.toolOutput")}</summary>
            <pre className="remote-entry-output">{props.text}</pre>
          </details>
        ) : null}
      </article>
    );
  }

  if (props.kind === "thinking") {
    return (
      <article className={className}>
        <details className="remote-entry-disclosure">
          <summary>
            <span className="remote-entry-kind">{t("remote.session.entry.thinking")}</span>
            {props.appended ? <StatusPill tone="accent">{t("remote.session.appended")}</StatusPill> : null}
            {time}
          </summary>
          <p className="remote-entry-text muted">{props.text}</p>
        </details>
      </article>
    );
  }

  if (props.kind === "notice") {
    // A turn that ended early: stopped by the user, or failed at the provider.
    // The provider's own words follow the notice when Pi recorded any.
    const stopped = props.notice === "aborted";
    return (
      <article className={`${className} ${stopped ? "stopped" : ""}`.trim()}>
        <header>
          <span className="remote-entry-kind">{t(stopped ? "remote.session.turnStopped" : "remote.session.turnFailed")}</span>
          {props.appended ? <StatusPill tone="accent">{t("remote.session.appended")}</StatusPill> : null}
          {time}
        </header>
        {props.text ? <p className="remote-entry-text">{props.text}</p> : null}
      </article>
    );
  }

  return (
    <article className={className}>
      <header>
        <span className="remote-entry-kind">{t(entryKindKey(props.kind))}</span>
        {props.appended ? <StatusPill tone="accent">{t("remote.session.appended")}</StatusPill> : null}
        {time}
      </header>
      {props.kind === "assistant" ? (
        <MarkdownMessage
          content={props.text}
          streaming={props.live}
          fileReferences="remote"
          onCopyCode={(code) => { void getBridge().writeClipboardText(code); }}
        />
      ) : (
        <p className="remote-entry-text">{props.text}</p>
      )}
    </article>
  );
}

function isSubmissionPending(
  value: RemoteSessionStartResult | RemoteSessionTranscript | RemoteSessionSubmissionPending | null
): value is RemoteSessionSubmissionPending {
  return Boolean(value && "pending" in value);
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
