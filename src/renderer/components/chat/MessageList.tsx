import { memo, useCallback, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { BrandSettings, ChatMessage } from "../../../shared/ipc";
import type { RunState } from "../../types";
import { BrainIcon } from "../icons/Icons";
import { LoadingDots } from "../ui/LoadingDots";
import { EmptyChatState } from "./EmptyChatState";
import { MessageJumpRail } from "./MessageJumpRail";
import { MessageActionsStateProvider, MessageView } from "./MessageView";
import { LiveRunHeader, RunActivityProvider } from "./RunHeader";
import { useI18n } from "../../i18n";

type MessageListProps = {
  messages: ChatMessage[];
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  loading: boolean;
  runState: RunState;
  runModelLabel: string | null;
  runActivityKey: string;
  error: string | null;
  actionKey: string;
  messageScrollRef: RefObject<HTMLDivElement | null>;
  modelLabel: string;
  brand: BrandSettings;
  onLoadOlderMessages(): void;
  onCopy(message: ChatMessage): void;
  onCopyCode(code: string): void;
  onRetry(message?: ChatMessage): void;
  onEditMessage(message: ChatMessage): void;
  onRemember(message: ChatMessage): void;
  onConfigureProvider(): void;
  onMessageWheel(deltaY: number): void;
  onMessageInteraction(): void;
  onMessageTailIntent(): void;
  onMessageScroll(): void;
};

export const MessageList = memo(function MessageList(props: MessageListProps) {
  recordHarnessRender();
  const { t } = useI18n();
  const providerSetupError = props.error ? isProviderSetupError(props.error) : false;
  const isRunning = props.runState === "running" || props.runState === "stopping";
  const pointerGestureRef = useRef<{ pointerId: number; startY: number } | null>(null);

  // Stabilize the row callbacks so MessageView's memo holds across stream ticks.
  // The latest parent handlers are read through a ref, so the identities passed to
  // each MessageView never change even when the messages array is replaced.
  const handlersRef = useRef(props);
  handlersRef.current = props;
  const handleCopy = useCallback((message: ChatMessage) => handlersRef.current.onCopy(message), []);
  const handleCopyCode = useCallback((code: string) => handlersRef.current.onCopyCode(code), []);
  const handleRetry = useCallback((message: ChatMessage) => {
    if (isRunActive(handlersRef.current.runState)) return;
    handlersRef.current.onRetry(message);
  }, []);
  const handleEdit = useCallback((message: ChatMessage) => {
    if (isRunActive(handlersRef.current.runState)) return;
    handlersRef.current.onEditMessage(message);
  }, []);
  const handleRemember = useCallback((message: ChatMessage) => handlersRef.current.onRemember(message), []);
  const handleMessageInteraction = useCallback(() => handlersRef.current.onMessageInteraction(), []);
  // The assistant message that owns this run's header only exists once the
  // first frame arrives. Until then a standalone header stands in at the same
  // place in the stack, sharing the run's clock origin, so sending a message
  // acknowledges immediately and nothing moves when the real block takes over.
  // Cumulative queued/steered snapshots retain completed assistant turns ahead
  // of the current one, and every member carries a stream id for reconciliation.
  // Only the trailing assistant owns the active run; using `some` here gives
  // every completed prefix assistant the same Working header.
  const tailMessage = props.messages.at(-1);
  const liveStreamSnapshotPresent = props.messages.some((message) => message.id.startsWith("stream-"));
  const liveAssistantPresent = Boolean(
    tailMessage?.role === "assistant" && tailMessage.id.startsWith("stream-")
  );
  // Settlement renames the assistant message off its stream id before the run
  // state reaches idle. Without this latch the stand-in would reappear for that
  // one commit and flash "Working" over an answer that just finished.
  const servedRunKeyRef = useRef<string | null>(null);
  if (liveAssistantPresent) servedRunKeyRef.current = props.runActivityKey;
  // Every settled turn's header consumes this context, and a context consumer
  // re-renders on a new value even behind memo. A fresh object per streamed
  // snapshot therefore re-renders the whole thread — and re-maps every
  // historical timeline's rows — once per chunk, making each chunk cost
  // proportional to the history above it. None of these fields change within a
  // run, so hold the identity steady and let the live turn be the only thing
  // that repaints.
  const runActivity = useMemo(
    () => (isRunning
      ? {
          runKey: props.runActivityKey,
          stopping: props.runState === "stopping",
          model: props.runModelLabel ?? props.modelLabel
        }
      : null),
    [isRunning, props.runActivityKey, props.runState, props.runModelLabel, props.modelLabel]
  );

  return (
    <div
      className={`message-scroll ${isRunning ? "is-running" : ""}`}
      ref={props.messageScrollRef}
      onWheel={(event) => props.onMessageWheel(event.deltaY)}
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest(".timeline-toggle, .run-header-toggle, .memory-used-line, .load-older-messages")) {
          props.onMessageInteraction();
        }
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary) return;
        pointerGestureRef.current = null;
        if (isScrollbarGutterPointer(event.currentTarget, event.clientX)) {
          props.onMessageInteraction();
          return;
        }
        pointerGestureRef.current = { pointerId: event.pointerId, startY: event.clientY };
      }}
      onPointerMove={(event) => {
        const gesture = pointerGestureRef.current;
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        if (Math.abs(event.clientY - gesture.startY) < 8) return;
        pointerGestureRef.current = null;
        props.onMessageInteraction();
      }}
      onPointerUp={(event) => {
        if (pointerGestureRef.current?.pointerId === event.pointerId) pointerGestureRef.current = null;
      }}
      onPointerCancel={(event) => {
        if (pointerGestureRef.current?.pointerId === event.pointerId) pointerGestureRef.current = null;
      }}
      onKeyDown={(event) => {
        if (["PageUp", "ArrowUp", "Home"].includes(event.key)) props.onMessageInteraction();
        if (event.key === "End") props.onMessageTailIntent();
      }}
      onScroll={props.onMessageScroll}
    >
      <div className={`message-stack ${props.messages.length === 0 ? "is-empty" : ""}`}>
        {props.loading ? (
          <div className="assistant-block thinking">
            <div className="thought-line">
              <BrainIcon />
              <span>{t("message.loadingJasmine")}</span>
              <LoadingDots />
            </div>
          </div>
        ) : props.messages.length === 0 ? (
          <EmptyChatState brand={props.brand} />
        ) : (
          <>
            {props.hasOlderMessages && (
              <button
                className="load-older-messages"
                type="button"
                disabled={props.loadingOlderMessages}
                onClick={props.onLoadOlderMessages}
              >
                {props.loadingOlderMessages ? t("message.loadingEarlier") : t("message.showEarlier")}
              </button>
            )}
            <MessageJumpRail messages={props.messages} onNavigate={handleMessageInteraction} />
            <MessageActionsStateProvider disabled={isRunning}>
              <RunActivityProvider value={runActivity}>
                {props.messages.map((message) => (
                  <MessageView
                    key={message.renderId ?? message.id}
                    message={message}
                    activeRunOwner={liveAssistantPresent && message === tailMessage}
                    onCopy={handleCopy}
                    onCopyCode={handleCopyCode}
                    onRetry={handleRetry}
                    onEdit={handleEdit}
                    onRemember={handleRemember}
                  />
                ))}
              </RunActivityProvider>
            </MessageActionsStateProvider>
          </>
        )}
        {runActivity
          && !liveAssistantPresent
          // A real queued/steered provider snapshot ends with the delivered
          // streamed user before its first assistant token. Restore the
          // placeholder for that live gap even though this request served an
          // earlier assistant; retain the latch only for the settlement commit,
          // whose persisted ids no longer identify a live stream snapshot.
          && (liveStreamSnapshotPresent || servedRunKeyRef.current !== props.runActivityKey)
          && (
            // Deliberately not an .assistant-block: this is the run's
            // acknowledgment, not a message. Sharing that selector would make
            // "the live assistant message" ambiguous for the moment before the
            // first frame arrives.
            <div className="run-placeholder">
              <LiveRunHeader
                key={runActivity.runKey}
                runKey={runActivity.runKey}
                stopping={runActivity.stopping}
                model={runActivity.model}
              />
            </div>
          )}
        {props.error && (
          <div className="error-strip">
            <span>{props.error}</span>
            {providerSetupError && (
              <button type="button" onClick={props.onConfigureProvider}>
                {t("message.configureProvider")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}, areMessageListPropsEqual);

function areMessageListPropsEqual(previous: MessageListProps, next: MessageListProps): boolean {
  return (
    previous.messages === next.messages &&
    previous.hasOlderMessages === next.hasOlderMessages &&
    previous.loadingOlderMessages === next.loadingOlderMessages &&
    previous.loading === next.loading &&
    previous.runState === next.runState &&
    previous.runModelLabel === next.runModelLabel &&
    previous.runActivityKey === next.runActivityKey &&
    previous.error === next.error &&
    previous.actionKey === next.actionKey &&
    previous.messageScrollRef === next.messageScrollRef &&
    previous.modelLabel === next.modelLabel &&
    previous.brand === next.brand
  );
}

function isRunActive(runState: RunState): boolean {
  return runState === "running" || runState === "stopping";
}

function isScrollbarGutterPointer(scroll: HTMLDivElement, clientX: number): boolean {
  const rect = scroll.getBoundingClientRect();
  const styles = window.getComputedStyle(scroll);
  const borderRight = Number.parseFloat(styles.borderRightWidth) || 0;
  const measuredGutter = Math.max(0, scroll.offsetWidth - scroll.clientWidth - borderRight);
  // Chromium may expose overlay scrollbars without subtracting their width from
  // clientWidth. Jasmine's scrollbar is 10px wide, so retain that hit target in
  // overlay mode while keeping ordinary clicks elsewhere in the message body inert.
  const gutterWidth = Math.max(10, measuredGutter);
  return clientX >= rect.right - borderRight - gutterWidth && clientX <= rect.right - borderRight;
}

function recordHarnessRender(): void {
  if (typeof window === "undefined" || !window.__JASMINE_HARNESS_ENABLED__) return;
  window.__JASMINE_MESSAGE_LIST_RENDERS__ = (window.__JASMINE_MESSAGE_LIST_RENDERS__ ?? 0) + 1;
}

function isProviderSetupError(message: string): boolean {
  return message.includes("env:") || message.includes("not set") || message.includes("disabled") || message.includes("No provider");
}

declare global {
  interface Window {
    __JASMINE_HARNESS_ENABLED__?: boolean;
    __JASMINE_MESSAGE_LIST_RENDERS__?: number;
  }
}
