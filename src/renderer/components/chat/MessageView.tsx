import { createContext, memo, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChatMessage, ChatTimelineItem } from "../../../shared/ipc";
import { BrainIcon, ChevronDownIcon, CopyIcon, EditIcon, MoreIcon, PlugIcon, RefreshIcon, SearchIcon, SkillIcon } from "../icons/Icons";
import { MessageTimeline } from "./MessageTimeline";
import { credentialSafeText, sanitizedHttpUrl } from "./safeDisplay";
import { useI18n } from "../../i18n";
import { Button, MenuItem, MenuSurface } from "../ui";
import { ImageLightbox } from "./ImageLightbox";
import { formatElapsedDuration, type RunStatus } from "./runPresentation";

declare global {
  interface Window {
    __JASMINE_HARNESS_ENABLED__?: boolean;
    __JASMINE_MESSAGE_VIEW_RENDERS__?: number;
    __JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__?: Record<string, number>;
  }
}
type MessageViewProps = {
  message: ChatMessage;
  onCopy: (message: ChatMessage) => void;
  onCopyCode: (code: string) => void;
  onRetry: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onRemember: (message: ChatMessage) => void;
};

const MessageActionsDisabledContext = createContext(false);

export function MessageActionsStateProvider(props: { disabled: boolean; children: ReactNode }) {
  return (
    <MessageActionsDisabledContext.Provider value={props.disabled}>
      {props.children}
    </MessageActionsDisabledContext.Provider>
  );
}

// Memoized so that during streaming only the live (changing) message re-renders.
// Settled messages keep a stable `message` object reference (see applyStreamEvent),
// and the callbacks passed in are stabilized by MessageList, so a shallow prop
// comparison keeps every settled bubble out of the per-chunk reconcile.
export const MessageView = memo(function MessageView(props: MessageViewProps) {
  recordHarnessRender(props.message.id);
  const { t } = useI18n();
  const [previewImage, setPreviewImage] = useState<NonNullable<ChatMessage["attachments"]>[number] | null>(null);
  const isLive = props.message.id.startsWith("stream-");

  if (props.message.role === "user") {
    return (
      <>
        <div className={`user-message-wrap ${isLive ? "live-message" : ""}`} data-message-id={props.message.id}>
          <div className="user-bubble">
            <AttachmentPreviewGrid attachments={props.message.attachments ?? []} onPreview={setPreviewImage} />
            {props.message.skillsUsed && props.message.skillsUsed.length > 0 && (
              <div className="user-inline-skill-row" aria-label={t("composer.inlineSkills")}>
                {props.message.skillsUsed.map((skill) => (
                  <span key={skill.id} title={skill.description}>
                    <SkillIcon />
                    <b>{skill.name}</b>
                  </span>
                ))}
              </div>
            )}
            {props.message.pluginsUsed && props.message.pluginsUsed.length > 0 && (
              <div className="user-inline-plugin-row" aria-label={t("composer.inlinePlugins")}>
                {props.message.pluginsUsed.map((plugin) => (
                  <span key={plugin.id} title={plugin.source}>
                    <PlugIcon />
                    <b>{plugin.name}</b>
                  </span>
                ))}
              </div>
            )}
            <span>{props.message.content}</span>
          </div>
          <UserMessageActions message={props.message} onEdit={props.onEdit} />
        </div>
        {previewImage?.previewDataUrl && (
          <ImageLightbox attachment={previewImage} onClose={() => setPreviewImage(null)} />
        )}
      </>
    );
  }

  const modelLabel = props.message.modelId ?? null;
  const timeline = normalizeTimeline(props.message);
  const runMeta = runMetaFromTimeline(timeline, modelLabel);
  const visibleTimeline = timeline.filter((item) => !isRunMetaSystemItem(item) && !isHiddenExtensionStateItem(item));
  const runStatus = runStatusFromMessage(props.message, visibleTimeline);
  const presentation = isLive ? null : partitionSettledTimeline(visibleTimeline);
  const finalText = presentation?.finalText || (isLive ? "" : fallbackFinalText(props.message, runStatus));
  const displayedFinalText = finalText || (!isLive && visibleTimeline.length === 0 ? props.message.content.trim() : "");
  const fallbackFinalItem = !isLive && presentation?.finalItems.length === 0 && displayedFinalText
    ? {
        id: `${props.message.renderId ?? props.message.id}-fallback-output`,
        kind: "assistant_text" as const,
        text: displayedFinalText
      }
    : undefined;
  const actionMessage = displayedFinalText && displayedFinalText !== props.message.content
    ? { ...props.message, content: displayedFinalText }
    : props.message;

  return (
    <article
      className={`assistant-block ${isLive ? "live-message" : ""} ${props.message.status === "error" ? "error-message" : ""}`}
      data-message-id={props.message.id}
      data-run-id={props.message.runId}
    >
      <MessageTimeline
        key="timeline"
        cacheScope={`${props.message.threadId}:${props.message.id}`}
        cacheAliasScopes={props.message.renderId && props.message.renderId !== props.message.id
          ? [`${props.message.threadId}:${props.message.renderId}`]
          : undefined}
        items={visibleTimeline}
        onCopyCode={props.onCopyCode}
        live={isLive}
        modelId={runMeta.model}
        settled={isLive ? undefined : {
          finalItemIds: presentation?.finalItems.map((item) => item.id) ?? [],
          fallbackFinalItem
        }}
      />
      {!isLive && (
        <RunCompletionLine
          status={runStatus}
          elapsedMs={props.message.elapsedMs}
          runMeta={runMeta}
          responseModelLabel={t("message.responseModel")}
        />
      )}
      <RunProvenance key="provenance" message={props.message} />
      <AssistantMessageActions
        message={props.message}
        actionMessage={actionMessage}
        onCopy={props.onCopy}
        onRetry={props.onRetry}
        onRemember={props.onRemember}
      />
    </article>
  );
}, areMessageViewPropsEqual);

function UserMessageActions(props: { message: ChatMessage; onEdit(message: ChatMessage): void }) {
  const { t } = useI18n();
  const disabled = useContext(MessageActionsDisabledContext);
  return (
    <div className="user-message-actions" aria-hidden={disabled || undefined}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => props.onEdit(props.message)}
        title={t("message.editMessage")}
        aria-label={t("message.editMessage")}
      >
        <EditIcon />
      </button>
    </div>
  );
}

function AssistantMessageActions(props: {
  message: ChatMessage;
  actionMessage: ChatMessage;
  onCopy(message: ChatMessage): void;
  onRetry(message: ChatMessage): void;
  onRemember(message: ChatMessage): void;
}) {
  const { t } = useI18n();
  const disabled = useContext(MessageActionsDisabledContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  // First commit the disabled state into the portal, then close it before
  // paint. The exit animation therefore retains disabled menu items instead
  // of a stale enabled snapshot for its final 160ms.
  useLayoutEffect(() => {
    if (disabled && menuOpen) setMenuOpen(false);
  }, [disabled, menuOpen]);

  return (
    <div className="message-actions" aria-hidden={disabled || undefined}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => props.onCopy(props.actionMessage)}
        title={t("message.copy")}
        aria-label={t("message.copy")}
      >
        <CopyIcon />
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => props.onRetry(props.message)}
        title={t("message.regenerate")}
        aria-label={t("message.regenerate")}
      >
        <RefreshIcon />
      </button>
      <div className="message-more">
        <button
          ref={moreButtonRef}
          type="button"
          disabled={disabled}
          onClick={() => setMenuOpen((open) => !open)}
          title={t("message.actions")}
          aria-label={t("message.actions")}
          aria-expanded={!disabled && menuOpen}
        >
          <MoreIcon />
        </button>
        <MenuSurface
          anchorRef={moreButtonRef}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          placement="top-end"
          minWidth={168}
          maxWidth={220}
          maxHeight={180}
          className="message-menu"
        >
          <MenuItem disabled={disabled} leftIcon={<CopyIcon />} onClick={() => { props.onCopy(props.actionMessage); setMenuOpen(false); }}>
            {t("message.copy")}
          </MenuItem>
          <MenuItem disabled={disabled} leftIcon={<RefreshIcon />} onClick={() => { props.onRetry(props.message); setMenuOpen(false); }}>
            {t("message.retryFromHere")}
          </MenuItem>
          <MenuItem disabled={disabled} leftIcon={<BrainIcon />} onClick={() => { props.onRemember(props.actionMessage); setMenuOpen(false); }}>
            {t("message.rememberThis")}
          </MenuItem>
        </MenuSurface>
      </div>
    </div>
  );
}

function areMessageViewPropsEqual(previous: MessageViewProps, next: MessageViewProps): boolean {
  return previous.message === next.message
    && previous.onCopy === next.onCopy
    && previous.onCopyCode === next.onCopyCode
    && previous.onRetry === next.onRetry
    && previous.onEdit === next.onEdit
    && previous.onRemember === next.onRemember;
}

function recordHarnessRender(messageId: string): void {
  if (typeof window === "undefined" || !window.__JASMINE_HARNESS_ENABLED__) return;
  window.__JASMINE_MESSAGE_VIEW_RENDERS__ = (window.__JASMINE_MESSAGE_VIEW_RENDERS__ ?? 0) + 1;
  const byId = window.__JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__ ?? {};
  byId[messageId] = (byId[messageId] ?? 0) + 1;
  window.__JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__ = byId;
}

function normalizeTimeline(message: ChatMessage): ChatTimelineItem[] {
  if (message.timeline && message.timeline.length > 0) return message.timeline;
  return [{
    id: `${message.id}-output`,
    kind: "assistant_text",
    text: message.content
  }];
}

function runMetaFromTimeline(items: ChatTimelineItem[], fallbackModel: string | null): { model: string | null; reasoningEffort: string | null } {
  const modelItem = findLastSystemItem(items, "Model");
  const thinkingItem = findLastSystemItem(items, "Thinking level");
  const model = modelItem?.text.split("/").at(-1)?.trim() || fallbackModel;
  return {
    model,
    reasoningEffort: thinkingItem?.text.trim() || null
  };
}

function findLastSystemItem(items: ChatTimelineItem[], title: string): Extract<ChatTimelineItem, { kind: "system" }> | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "system" && item.title === title) return item;
  }
  return null;
}

function isRunMetaSystemItem(item: ChatTimelineItem): boolean {
  return item.kind === "system" && (item.title === "Model" || item.title === "Thinking level");
}

function isHiddenExtensionStateItem(item: ChatTimelineItem): boolean {
  return item.kind === "system" && Boolean(item.customType);
}

function RunCompletionLine(props: {
  status: RunStatus;
  elapsedMs?: number;
  runMeta: { model: string | null; reasoningEffort: string | null };
  responseModelLabel: string;
}) {
  const { language, t } = useI18n();
  const duration = formatElapsedDuration(props.elapsedMs, language);
  const label = props.status === "stopped"
    ? duration ? t("message.stoppedAfter", { duration }) : t("message.stoppedWorkDetails")
    : props.status === "error"
      ? duration ? t("message.failedAfter", { duration }) : t("message.failedWorkDetails")
      : duration ? t("message.workedFor", { duration }) : null;
  if (!label && !props.runMeta.model) return null;
  return (
    <div className={`run-completion-line message-run-line ${props.status}`} aria-label={props.responseModelLabel}>
      {label && <span>{label}</span>}
      {props.runMeta.model && <small>{props.runMeta.model}</small>}
      {props.runMeta.reasoningEffort && <small>{props.runMeta.reasoningEffort}</small>}
    </div>
  );
}

function RunProvenance(props: { message: ChatMessage }) {
  const { t } = useI18n();
  const [memoryExpanded, setMemoryExpanded] = useState(false);
  return (
    <>
      {props.message.memoryUsed && props.message.memoryUsed.length > 0 && (
        <div className={`memory-used-provenance ${memoryExpanded ? "expanded" : ""}`}>
          <Button
            className="memory-used-line"
            size="sm"
            variant="quiet"
            leftIcon={<BrainIcon />}
            rightIcon={<ChevronDownIcon />}
            aria-label={t("message.memoryUsed")}
            aria-expanded={memoryExpanded}
            onClick={() => setMemoryExpanded((expanded) => !expanded)}
          >
            {t("message.usedMemory")}
          </Button>
          {memoryExpanded && (
            <div className="memory-used-detail">
              {props.message.memoryUsed.map((memory) => <p key={memory.id}>{memory.content}</p>)}
            </div>
          )}
        </div>
      )}
      {props.message.skillsUsed && props.message.skillsUsed.length > 0 && (
        <div className="skill-used-line" aria-label={t("message.skillsUsed")}>
          <SkillIcon />
          <span>{t("message.usedSkills")}</span>
          <small>{props.message.skillsUsed.map((skill) => skill.name).join(", ")}</small>
        </div>
      )}
      {props.message.pluginsUsed && props.message.pluginsUsed.length > 0 && (
        <div className="plugin-used-line" aria-label={t("message.pluginsUsed")}>
          <PlugIcon />
          <span>{t("message.usedPlugins")}</span>
          <small>{props.message.pluginsUsed.map((plugin) => plugin.name).join(", ")}</small>
        </div>
      )}
      {props.message.webSearchUsed && props.message.webSearchUsed.length > 0 && (
        <div className="web-search-used-line" aria-label={t("message.webSearchUsed")}>
          <SearchIcon />
          <span>{t("message.usedWebSearch")}</span>
          <small>{props.message.webSearchUsed.map(safeProvenanceLabel).filter(Boolean).join(" / ")}</small>
        </div>
      )}
    </>
  );
}

function safeProvenanceLabel(result: NonNullable<ChatMessage["webSearchUsed"]>[number]): string {
  const url = sanitizedHttpUrl(result.url);
  const title = result.title.trim() === result.url.trim()
    ? url
    : credentialSafeText(result.title);
  if (title && url && title !== url) return `${title} - ${url}`;
  return title || url;
}

function partitionSettledTimeline(items: ChatTimelineItem[]): {
  details: ChatTimelineItem[];
  finalItems: Array<Extract<ChatTimelineItem, { kind: "assistant_text" }>>;
  finalText: string;
} {
  let suffixEnd = items.length - 1;
  while (suffixEnd >= 0 && isTerminalStatusItem(items[suffixEnd])) suffixEnd -= 1;

  let suffixStart = suffixEnd;
  while (suffixStart >= 0) {
    const item = items[suffixStart];
    if (item.kind !== "assistant_text" || !item.text.trim()) break;
    suffixStart -= 1;
  }

  const finalItems = items.slice(suffixStart + 1, suffixEnd + 1)
    .filter((item): item is Extract<ChatTimelineItem, { kind: "assistant_text" }> => item.kind === "assistant_text" && Boolean(item.text.trim()));
  if (finalItems.length === 0) return { details: items, finalItems: [], finalText: "" };

  const finalIds = new Set(finalItems.map((item) => item.id));
  return {
    details: items.filter((item) => !finalIds.has(item.id)),
    finalItems,
    finalText: finalItems.map((item) => item.text.trim()).join("\n\n")
  };
}

function isTerminalStatusItem(item: ChatTimelineItem): boolean {
  return item.kind === "system" && item.title.trim().toLowerCase() === "stopped";
}

function runStatusFromMessage(message: ChatMessage, timeline: ChatTimelineItem[]): RunStatus {
  if (message.status === "error") return "error";
  if (timeline.some(isTerminalStatusItem)) return "stopped";
  return "success";
}

function fallbackFinalText(message: ChatMessage, status: RunStatus): string {
  if (status === "success") return "";
  return message.content.trim();
}

function AttachmentPreviewGrid(props: {
  attachments: NonNullable<ChatMessage["attachments"]>;
  onPreview(attachment: NonNullable<ChatMessage["attachments"]>[number]): void;
}) {
  const { t } = useI18n();
  const imageAttachments = props.attachments.filter((item) => item.isImage && item.previewDataUrl);
  if (imageAttachments.length === 0) return null;

  return (
    <div className="message-image-grid">
      {imageAttachments.map((item) => (
        <button key={item.path} type="button" onClick={() => props.onPreview(item)} aria-label={t("message.previewAttachment", { name: item.name })}>
          <img src={item.previewDataUrl} alt={item.name} title={item.name} />
        </button>
      ))}
    </div>
  );
}
