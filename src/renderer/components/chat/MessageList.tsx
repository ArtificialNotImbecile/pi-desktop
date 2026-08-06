import { memo, useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { BrandSettings, ChatMessage } from "../../../shared/ipc";
import type { RunState } from "../../types";
import { BrainIcon } from "../icons/Icons";
import { LoadingDots } from "../ui/LoadingDots";
import { EmptyChatState } from "./EmptyChatState";
import { MessageJumpRail } from "./MessageJumpRail";
import { MessageView } from "./MessageView";
import { useI18n } from "../../i18n";

type MessageListProps = {
  messages: ChatMessage[];
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  loading: boolean;
  runState: RunState;
  runModelLabel: string | null;
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
  onMessageScroll(): void;
};

export const MessageList = memo(function MessageList(props: MessageListProps) {
  recordHarnessRender();
  const { t } = useI18n();
  const providerSetupError = props.error ? isProviderSetupError(props.error) : false;
  const isRunning = props.runState === "running" || props.runState === "stopping";

  // Stabilize the row callbacks so MessageView's memo holds across stream ticks.
  // The latest parent handlers are read through a ref, so the identities passed to
  // each MessageView never change even when the messages array is replaced.
  const handlersRef = useRef(props);
  handlersRef.current = props;
  const handleCopy = useCallback((message: ChatMessage) => handlersRef.current.onCopy(message), []);
  const handleCopyCode = useCallback((code: string) => handlersRef.current.onCopyCode(code), []);
  const handleRetry = useCallback((message: ChatMessage) => handlersRef.current.onRetry(message), []);
  const handleEdit = useCallback((message: ChatMessage) => handlersRef.current.onEditMessage(message), []);
  const handleRemember = useCallback((message: ChatMessage) => handlersRef.current.onRemember(message), []);
  const hasLiveAssistant = props.messages.some((message) => isLiveMessage(message) && message.role === "assistant");
  const runningLabel = props.runState === "stopping"
    ? t("message.stopping")
    : t("message.thinkingWith", { model: props.runModelLabel ?? props.modelLabel });

  return (
    <div
      className="message-scroll"
      ref={props.messageScrollRef}
      onWheel={(event) => props.onMessageWheel(event.deltaY)}
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
            <MessageJumpRail messages={props.messages} />
            {props.messages.map((message) => (
              <MessageView
                key={message.id}
                message={message}
                onCopy={handleCopy}
                onCopyCode={handleCopyCode}
                onRetry={handleRetry}
                onEdit={handleEdit}
                onRemember={handleRemember}
                actionsDisabled={isRunning}
              />
            ))}
          </>
        )}
        {isRunning && !hasLiveAssistant && (
          <div className="assistant-block thinking">
            <div className="thought-line">
              <BrainIcon />
              <span>{runningLabel}</span>
              <LoadingDots />
            </div>
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
    previous.error === next.error &&
    previous.actionKey === next.actionKey &&
    previous.messageScrollRef === next.messageScrollRef &&
    previous.modelLabel === next.modelLabel &&
    previous.brand === next.brand
  );
}

function isLiveMessage(message: ChatMessage): boolean {
  return message.id.startsWith("stream-");
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
