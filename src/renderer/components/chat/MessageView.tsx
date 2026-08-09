import { memo, useRef, useState } from "react";
import type { ChatMessage, ChatTimelineItem } from "../../../shared/ipc";
import { BrainIcon, CopyIcon, EditIcon, MoreIcon, PlugIcon, RefreshIcon, SearchIcon, SkillIcon } from "../icons/Icons";
import { MessageTimeline } from "./MessageTimeline";
import { useI18n } from "../../i18n";
import { MenuItem, MenuSurface } from "../ui";
import { ImageLightbox } from "./ImageLightbox";
import { MarkdownMessage } from "./MarkdownMessage";
import { RunRecap, type RunRecapStatus } from "./RunRecap";

declare global {
  interface Window {
    __JASMINE_HARNESS_ENABLED__?: boolean;
    __JASMINE_MESSAGE_VIEW_RENDERS__?: number;
  }
}
type MessageViewProps = {
  message: ChatMessage;
  onCopy: (message: ChatMessage) => void;
  onCopyCode: (code: string) => void;
  onRetry: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onRemember: (message: ChatMessage) => void;
  actionsDisabled?: boolean;
};

// Memoized so that during streaming only the live (changing) message re-renders.
// Settled messages keep a stable `message` object reference (see applyStreamEvent),
// and the callbacks passed in are stabilized by MessageList, so a shallow prop
// comparison keeps every settled bubble out of the per-chunk reconcile.
export const MessageView = memo(function MessageView(props: MessageViewProps) {
  recordHarnessRender();
  const { t } = useI18n();
  const [previewImage, setPreviewImage] = useState<NonNullable<ChatMessage["attachments"]>[number] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
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
          {!isLive && !props.actionsDisabled && (
            <div className="user-message-actions">
              <button type="button" onClick={() => props.onEdit(props.message)} title={t("message.editMessage")} aria-label={t("message.editMessage")}>
                <EditIcon />
              </button>
            </div>
          )}
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

  if (isLive) {
    return (
      <article className="assistant-block live-message" data-message-id={props.message.id}>
        <RunMetaLine runMeta={runMeta} responseModelLabel={t("message.responseModel")} />
        <MessageTimeline items={visibleTimeline} onCopyCode={props.onCopyCode} live modelId={runMeta.model} />
        <RunProvenance message={props.message} />
      </article>
    );
  }

  const presentation = partitionSettledTimeline(visibleTimeline);
  const finalText = presentation.finalText || fallbackFinalText(props.message, runStatus);
  const detailsTimeline = presentation.details.filter((item) => !isRunMetaSystemItem(item));
  const hasProvenance = hasRunProvenance(props.message);
  const hasRecap = detailsTimeline.length > 0
    || Boolean(runMeta.model)
    || Boolean(runMeta.reasoningEffort)
    || hasProvenance
    || props.message.elapsedMs !== undefined
    || runStatus !== "success";
  const actionMessage = finalText && finalText !== props.message.content
    ? { ...props.message, content: finalText }
    : props.message;

  return (
    <article
      className={`assistant-block ${props.message.status === "error" ? "error-message" : ""}`}
      data-message-id={props.message.id}
      data-run-id={props.message.runId}
    >
      {hasRecap && (
        <RunRecap
          status={runStatus}
          elapsedMs={props.message.elapsedMs}
          defaultExpanded={runStatus !== "success" || !finalText}
        >
          <RunMetaLine runMeta={runMeta} responseModelLabel={t("message.responseModel")} />
          {detailsTimeline.length > 0 && (
            <MessageTimeline items={detailsTimeline} onCopyCode={props.onCopyCode} modelId={runMeta.model} />
          )}
          {hasProvenance && <RunProvenance message={props.message} />}
        </RunRecap>
      )}
      {finalText && (
        <section className="timeline-output final-answer" aria-label="Assistant output">
          <MarkdownMessage content={finalText} onCopyCode={props.onCopyCode} />
        </section>
      )}
      {!hasRecap && !finalText && props.message.content.trim() && (
        <section className="timeline-output final-answer" aria-label="Assistant output">
          <MarkdownMessage content={props.message.content} onCopyCode={props.onCopyCode} />
        </section>
      )}
      {!props.actionsDisabled && (
        <div className="message-actions">
          <button type="button" onClick={() => props.onCopy(actionMessage)} title={t("message.copy")} aria-label={t("message.copy")}>
            <CopyIcon />
          </button>
          <button type="button" onClick={() => props.onRetry(props.message)} title={t("message.regenerate")} aria-label={t("message.regenerate")}>
            <RefreshIcon />
          </button>
          <div className="message-more">
            <button
              ref={moreButtonRef}
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              title={t("message.actions")}
              aria-label={t("message.actions")}
              aria-expanded={menuOpen}
            >
              <MoreIcon />
            </button>
            <MenuSurface anchorRef={moreButtonRef} open={menuOpen} onOpenChange={setMenuOpen} placement="top-end" minWidth={168} maxWidth={220} maxHeight={180} className="message-menu">
              <MenuItem leftIcon={<CopyIcon />} onClick={() => { props.onCopy(actionMessage); setMenuOpen(false); }}>
                {t("message.copy")}
              </MenuItem>
              <MenuItem leftIcon={<RefreshIcon />} onClick={() => { props.onRetry(props.message); setMenuOpen(false); }}>
                {t("message.retryFromHere")}
              </MenuItem>
              <MenuItem leftIcon={<BrainIcon />} onClick={() => { props.onRemember(actionMessage); setMenuOpen(false); }}>
                {t("message.rememberThis")}
              </MenuItem>
            </MenuSurface>
          </div>
        </div>
      )}
    </article>
  );
});

function recordHarnessRender(): void {
  if (typeof window === "undefined" || !window.__JASMINE_HARNESS_ENABLED__) return;
  window.__JASMINE_MESSAGE_VIEW_RENDERS__ = (window.__JASMINE_MESSAGE_VIEW_RENDERS__ ?? 0) + 1;
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

function RunMetaLine(props: {
  runMeta: { model: string | null; reasoningEffort: string | null };
  responseModelLabel: string;
}) {
  if (!props.runMeta.model) return null;
  return (
    <div className="message-run-line" aria-label={props.responseModelLabel}>
      <span>{props.runMeta.model}</span>
      {props.runMeta.reasoningEffort && <small>{props.runMeta.reasoningEffort}</small>}
    </div>
  );
}

function RunProvenance(props: { message: ChatMessage }) {
  const { t } = useI18n();
  return (
    <>
      {props.message.memoryUsed && props.message.memoryUsed.length > 0 && (
        <div className="memory-used-line" aria-label={t("message.memoryUsed")}>
          <BrainIcon />
          <span>{t("message.usedMemory")}</span>
          <small>{props.message.memoryUsed.map((memory) => memory.content).join(" · ")}</small>
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
          <small>{props.message.webSearchUsed.map((result) => `${result.title} - ${result.url}`).join(" / ")}</small>
        </div>
      )}
    </>
  );
}

function hasRunProvenance(message: ChatMessage): boolean {
  return Boolean(
    message.memoryUsed?.length
    || message.skillsUsed?.length
    || message.pluginsUsed?.length
    || message.webSearchUsed?.length
  );
}

function partitionSettledTimeline(items: ChatTimelineItem[]): { details: ChatTimelineItem[]; finalText: string } {
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
  if (finalItems.length === 0) return { details: items, finalText: "" };

  const finalIds = new Set(finalItems.map((item) => item.id));
  return {
    details: items.filter((item) => !finalIds.has(item.id)),
    finalText: finalItems.map((item) => item.text.trim()).join("\n\n")
  };
}

function isTerminalStatusItem(item: ChatTimelineItem): boolean {
  return item.kind === "system" && item.title.trim().toLowerCase() === "stopped";
}

function runStatusFromMessage(message: ChatMessage, timeline: ChatTimelineItem[]): RunRecapStatus {
  if (message.status === "error") return "error";
  if (timeline.some(isTerminalStatusItem)) return "stopped";
  return "success";
}

function fallbackFinalText(message: ChatMessage, status: RunRecapStatus): string {
  if (status === "success") return "";
  return message.content.trim();
}

function AttachmentPreviewGrid(props: {
  attachments: NonNullable<ChatMessage["attachments"]>;
  onPreview(attachment: NonNullable<ChatMessage["attachments"]>[number]): void;
}) {
  const imageAttachments = props.attachments.filter((item) => item.isImage && item.previewDataUrl);
  if (imageAttachments.length === 0) return null;

  return (
    <div className="message-image-grid">
      {imageAttachments.map((item) => (
        <button key={item.path} type="button" onClick={() => props.onPreview(item)} aria-label={`Preview ${item.name}`}>
          <img src={item.previewDataUrl} alt={item.name} title={item.name} />
        </button>
      ))}
    </div>
  );
}
