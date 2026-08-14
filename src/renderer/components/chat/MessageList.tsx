import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { BrandSettings, ChatMessage } from "../../../shared/ipc";
import type { RunState } from "../../types";
import { BrainIcon } from "../icons/Icons";
import { LoadingDots } from "../ui/LoadingDots";
import { EmptyChatState } from "./EmptyChatState";
import { MessageJumpRail } from "./MessageJumpRail";
import { MessageActionsStateProvider, MessageView } from "./MessageView";
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

const runActivityStartedAtCache = new Map<string, number>();
const RUN_ACTIVITY_START_CACHE_LIMIT = 500;

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
  const runningLabel = props.runState === "stopping"
    ? t("message.stopping")
    : t("message.thinkingWith", { model: props.runModelLabel ?? props.modelLabel });

  return (
    <div
      className={`message-scroll ${isRunning ? "is-running" : ""}`}
      ref={props.messageScrollRef}
      onWheel={(event) => props.onMessageWheel(event.deltaY)}
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest(".timeline-toggle, .memory-used-line, .load-older-messages")) {
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
              {props.messages.map((message) => (
                <MessageView
                  key={message.renderId ?? message.id}
                  message={message}
                  onCopy={handleCopy}
                  onCopyCode={handleCopyCode}
                  onRetry={handleRetry}
                  onEdit={handleEdit}
                  onRemember={handleRemember}
                />
              ))}
            </MessageActionsStateProvider>
          </>
        )}
        {isRunning && (
          <TurnActivity key={props.runActivityKey} runKey={props.runActivityKey} label={runningLabel} stopping={props.runState === "stopping"} />
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

function TurnActivity(props: { runKey: string; label: string; stopping: boolean }) {
  const [startedAt] = useState(() => startedAtForRun(props.runKey));
  const [elapsedSeconds, setElapsedSeconds] = useState(() => Math.floor((Date.now() - startedAt) / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const clock = elapsedSeconds >= 15
    ? `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`
    : null;
  return (
    <div className={`turn-activity ${props.stopping ? "stopping" : ""}`} role="status" aria-live="polite">
      <span>{props.label}</span>
      {clock && <time aria-hidden="true">{clock}</time>}
    </div>
  );
}

function startedAtForRun(runKey: string): number {
  const remembered = runActivityStartedAtCache.get(runKey);
  if (remembered !== undefined) return remembered;
  if (runActivityStartedAtCache.size >= RUN_ACTIVITY_START_CACHE_LIMIT) {
    const oldest = runActivityStartedAtCache.keys().next().value;
    if (oldest !== undefined) runActivityStartedAtCache.delete(oldest);
  }
  const startedAt = Date.now();
  runActivityStartedAtCache.set(runKey, startedAt);
  return startedAt;
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
