import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { ChatTimelineItem } from "../../../shared/ipc";
import { BrainIcon, ChevronDownIcon, EditIcon, FileIcon, SearchIcon, TerminalIcon, WrenchIcon } from "../icons/Icons";
import { MarkdownMessage } from "./MarkdownMessage";
import { useI18n } from "../../i18n";
import { languageFromPath, looksLikeDiff, looksLikeJson, ShikiCodeBlock, type CodeBlockKind } from "../code";
import { credentialSafeText, sanitizedHttpUrl } from "./safeDisplay";

declare global {
  interface Window {
    __JASMINE_HARNESS_ENABLED__?: boolean;
    __JASMINE_TIMELINE_ROW_RENDERS__?: Record<string, number>;
  }
}

// Thought and tool rows own their expansion independently. Mirror toggles into
// this bounded cache so pagination or thread navigation does not unexpectedly
// reopen a row the reader deliberately collapsed (or vice versa).
// A separator that cannot occur in a thread id, message id or item id, so two
// different (scope, item) pairs can never collide on one cache key.
const EXPANSION_KEY_SEPARATOR = "\u0000";
const expansionStateCache = new Map<string, boolean>();
const EXPANSION_CACHE_LIMIT = 500;

function rememberExpansion(itemId: string, expanded: boolean) {
  if (expansionStateCache.size >= EXPANSION_CACHE_LIMIT && !expansionStateCache.has(itemId)) {
    expansionStateCache.clear();
  }
  expansionStateCache.set(itemId, expanded);
}

type SettledTimelinePresentation = {
  finalItemIds: string[];
  fallbackFinalItem?: Extract<ChatTimelineItem, { kind: "assistant_text" }>;
};

export function MessageTimeline(props: {
  cacheScope: string;
  cacheAliasScopes?: string[];
  items: ChatTimelineItem[];
  onCopyCode(code: string): void;
  live?: boolean;
  modelId?: string | null;
  settled?: SettledTimelinePresentation;
  // Codex-style turn collapse: activity rows fold behind the run header while
  // the final answer stays. Rows stay mounted so reopening is instant and the
  // reader's per-row disclosures survive.
  collapsed?: boolean;
}) {
  const retainedLiveDetailsRef = useRef(Boolean(props.live));
  if (props.live) retainedLiveDetailsRef.current = true;
  // Once a row has painted live, keep its structural classification and default
  // expansion through settlement. Reclassifying a no-thinking text preamble or
  // collapsing thinking at the final event would replace content the user has
  // already seen. A directly loaded persisted message still gets the canonical
  // settled presentation.
  const retainPaintedPresentation = Boolean(props.live) || retainedLiveDetailsRef.current;
  const timelineItems = useMemo(
    () => props.settled?.fallbackFinalItem
      ? [...props.items, props.settled.fallbackFinalItem]
      : props.items,
    [props.items, props.settled?.fallbackFinalItem]
  );
  const displayItems = useMemo(
    () => compactTimelineItems(timelineItems, retainPaintedPresentation, props.modelId),
    [timelineItems, retainPaintedPresentation, props.modelId]
  );
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  // A live row is keyed by its renderer identity, while its database-backed
  // replacement is keyed by the persisted message id. During the settlement
  // render both identities are available; copy the live disclosure choices to
  // the persisted scope before a later thread navigation drops renderId.
  useLayoutEffect(() => {
    if (!props.cacheAliasScopes?.length) return;
    for (const item of displayItems) {
      const stableKey = expansionKey(props.cacheScope, item.id);
      if (expansionStateCache.has(stableKey)) continue;
      const expansion = expandedItems[item.id]
        ?? firstAliasedExpansion(props.cacheAliasScopes, item.id);
      if (expansion !== undefined) rememberExpansion(stableKey, expansion);
    }
  }, [displayItems, expandedItems, props.cacheAliasScopes, props.cacheScope]);
  const isExpanded = (item: TimelineDisplayItem) => expandedItems[item.id]
    ?? expansionStateCache.get(expansionKey(props.cacheScope, item.id))
    ?? firstAliasedExpansion(props.cacheAliasScopes, item.id)
    ?? item.defaultExpanded;
  const toggleItem = useCallback((itemId: string, expanded: boolean) => {
    rememberExpansion(expansionKey(props.cacheScope, itemId), !expanded);
    setExpandedItems((current) => ({ ...current, [itemId]: !expanded }));
  }, [props.cacheScope]);

  const finalIds = new Set(props.settled?.finalItemIds ?? []);
  if (props.settled?.fallbackFinalItem) finalIds.add(props.settled.fallbackFinalItem.id);
  const activeLiveItemId = props.live ? displayItems.at(-1)?.id : undefined;
  // Assistant text keeps its streaming parser identity for the whole run so a
  // later tool append cannot rerender already-painted Markdown. Only the
  // segment currently producing tokens carries the running sweep.
  const rowIsLive = (item: TimelineDisplayItem) => Boolean(props.live)
    && (item.kind === "assistant_text" || (item.kind === "thinking" && item.id === activeLiveItemId));

  // Every thought/tool row stays in chronological flow and owns its own compact
  // disclosure. Collapsing the turn hides the activity rows without unmounting
  // them; the final answer is never hidden.
  return (
    <div className="message-timeline">
      {displayItems.map((item) => (
        <TimelineDisplayRow
          key={item.id}
          item={item}
          expanded={isExpanded(item)}
          live={rowIsLive(item)}
          finalAnswer={finalIds.has(item.id)}
          hidden={Boolean(props.collapsed) && !finalIds.has(item.id)}
          onCopyCode={props.onCopyCode}
          onToggle={toggleItem}
        />
      ))}
    </div>
  );
}

function expansionKey(scope: string, itemId: string): string {
  return `${scope}${EXPANSION_KEY_SEPARATOR}${itemId}`;
}

/**
 * Whether the reader has opened any row belonging to these cache scopes.
 *
 * A turn that settles while the reader is reading one of its rows must not fold
 * that row away underneath them, so opening a row opts the turn out of the
 * automatic collapse. Scroll position alone is not consulted: it lives outside
 * this component, and an opened row is the signal that survives settlement.
 */
export function hasOpenedRowInScopes(scopes: Array<string | undefined>): boolean {
  const prefixes = scopes.filter((scope): scope is string => Boolean(scope)).map((scope) => `${scope}${EXPANSION_KEY_SEPARATOR}`);
  if (prefixes.length === 0) return false;
  for (const [key, expanded] of expansionStateCache) {
    if (expanded && prefixes.some((prefix) => key.startsWith(prefix))) return true;
  }
  return false;
}

function firstAliasedExpansion(aliasScopes: string[] | undefined, itemId: string): boolean | undefined {
  for (const scope of aliasScopes ?? []) {
    const value = expansionStateCache.get(expansionKey(scope, itemId));
    if (value !== undefined) return value;
  }
  return undefined;
}

type TimelineDisplayItem =
  | { id: string; kind: "thinking"; text: string; defaultExpanded: boolean }
  | { id: string; kind: "tool_preamble"; text: string; defaultExpanded: boolean }
  | { id: string; kind: "tool"; toolName: string; call?: Extract<ChatTimelineItem, { kind: "tool_call" }>; result?: Extract<ChatTimelineItem, { kind: "tool_result" }>; summary: ToolSummary; defaultExpanded: boolean }
  | { id: string; kind: "assistant_text"; text: string; defaultExpanded: boolean }
  | { id: string; kind: "system"; title: string; text: string; collapsible: boolean; defaultExpanded: boolean };

type RowState = "done" | "running" | "stopped" | "error";

type ToolSummary = {
  state: RowState;
  // The tool's own name, shown verbatim: it identifies the command, not a
  // narrated action, so it is deliberately not localized.
  title: string;
  // What the tool acted on. Credential-bearing text collapses to empty rather
  // than reaching the row.
  target: string;
  // A mutation magnitude the reader should see without opening the row. Kept
  // out of the target's ellipsis. Result counts and byte totals do not qualify;
  // they belong to the OUT section.
  suffix: string;
  details: ToolDetail[];
};

type ToolDetail = { label: "IN" | "OUT"; content: string; tone?: "error" | "code" };

type TimelineDisplayRowProps = {
  item: TimelineDisplayItem;
  expanded: boolean;
  live: boolean;
  finalAnswer: boolean;
  hidden: boolean;
  onCopyCode(code: string): void;
  onToggle(itemId: string, expanded: boolean): void;
};

const TimelineDisplayRow = memo(function TimelineDisplayRow(props: TimelineDisplayRowProps) {
  const { t } = useI18n();
  const { item } = props;
  recordTimelineRowRender(item.id);
  const toggle = () => props.onToggle(item.id, props.expanded);
  const detailsMountedRef = useRef(props.expanded);
  if (props.expanded) detailsMountedRef.current = true;

  if (item.kind === "thinking") {
    return (
      <TimelineRow
        itemId={item.id}
        className="thinking-item"
        icon={<BrainIcon />}
        title={t("message.thinking")}
        summary={thoughtSummary(item.text, props.live)}
        state={props.live ? "running" : "done"}
        expanded={props.expanded}
        hidden={props.hidden}
        onToggle={toggle}
      >
        {detailsMountedRef.current && (
          <div className="timeline-row-thought">
            <MarkdownMessage content={item.text} onCopyCode={props.onCopyCode} streaming={props.live} />
          </div>
        )}
      </TimelineRow>
    );
  }
  if (item.kind === "tool_preamble") {
    return (
      <TimelineRow
        itemId={item.id}
        className="thinking-item tool-preamble-item"
        icon={<WrenchIcon />}
        title={t("message.toolPreamble")}
        summary={thoughtSummary(item.text, false)}
        state="done"
        expanded={props.expanded}
        hidden={props.hidden}
        onToggle={toggle}
      >
        {detailsMountedRef.current && (
          <div className="timeline-row-thought">
            <MarkdownMessage content={item.text} onCopyCode={props.onCopyCode} streaming={props.live} />
          </div>
        )}
      </TimelineRow>
    );
  }
  if (item.kind === "tool") {
    return <ToolRunRow item={item} expanded={props.expanded} hidden={props.hidden} onToggle={toggle} />;
  }
  if (item.kind === "system") {
    const title = localizedSystemTitle(item.title, t);
    if (item.collapsible) {
      return (
        <TimelineRow
          itemId={item.id}
          className="thinking-item system-summary-item"
          icon={<TerminalIcon />}
          title={title}
          summary=""
          state="done"
          expanded={props.expanded}
          hidden={props.hidden}
          onToggle={toggle}
        >
          {detailsMountedRef.current && (
            <div className="timeline-row-thought">
              <MarkdownMessage content={item.text} onCopyCode={props.onCopyCode} />
            </div>
          )}
        </TimelineRow>
      );
    }
    return (
      <TimelineRow
        itemId={item.id}
        className="system-item"
        icon={<TerminalIcon />}
        title={title}
        // Even product-owned inline status text gets the collapsed-preview
        // credential guard. An extension can reuse a familiar title, so the
        // title alone is never authority to expose arbitrary text.
        summary={credentialSafeText(item.text)}
        state="done"
        expanded={false}
        hidden={props.hidden}
      />
    );
  }
  return (
    <section
      data-timeline-item-id={item.id}
      className={`timeline-output ${props.finalAnswer ? "final-answer" : ""}`}
      hidden={props.hidden || undefined}
      aria-label={t("message.assistantOutput")}
    >
      <MarkdownMessage content={item.text} onCopyCode={props.onCopyCode} streaming={props.live} />
    </section>
  );
}, sameTimelineDisplayRowProps);

/**
 * The single 24px row grammar every activity row uses:
 *
 *   [16px leading][6px][title 14/24][8px][2px dot][8px][summary fill, ellipsis][suffix]
 *
 * The leading slot carries the icon at rest and the chevron on hover or while
 * open, so no disclosure control sits at the row's end and every row shares one
 * left axis with the answer body. Run state is colour and motion only, so an
 * off-nominal row also emits a visually hidden label.
 */
function TimelineRow(props: {
  itemId: string;
  className: string;
  icon: ReactElement;
  title: string;
  summary: string;
  summaryTone?: "error";
  suffix?: string;
  state: RowState;
  expanded: boolean;
  hidden: boolean;
  toolName?: string;
  onToggle?(): void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const summaryId = useId();
  const expandable = Boolean(props.onToggle);
  const stateLabel = runStateLabel(props.state, t);
  // The name stays the row's kind, not its content: a streaming thought rewrites
  // its summary on every chunk, and a changing accessible name makes assistive
  // tech re-announce the control. The summary rides along as the description.
  const describedBy = !props.expanded && props.summary ? summaryId : undefined;
  const rowContent = (
    <>
      <span className="timeline-row-lead">
        <span className="timeline-row-icon">
          {props.state === "error" || props.state === "stopped"
            ? <span className={`timeline-row-state-dot ${props.state}`} aria-hidden="true" />
            : props.icon}
        </span>
        {expandable && <span className="timeline-row-chevron"><ChevronDownIcon /></span>}
      </span>
      <span className="timeline-row-title">{props.title}</span>
      {props.summary && (
        <>
          <span className="timeline-row-dot" aria-hidden="true" />
          <span id={summaryId} className={`timeline-row-summary ${props.summaryTone === "error" ? "error" : ""}`}>{props.summary}</span>
        </>
      )}
      {props.suffix && <span className="timeline-row-suffix">{props.suffix}</span>}
    </>
  );
  return (
    <section
      data-timeline-item-id={props.itemId}
      data-tool-name={props.toolName}
      className={`timeline-item ${props.className} ${props.state} ${props.expanded ? "" : "collapsed"}`}
      hidden={props.hidden || undefined}
    >
      {stateLabel && <span className="timeline-row-state-text">{stateLabel}</span>}
      {expandable ? (
        <button
          type="button"
          className="timeline-row timeline-toggle"
          aria-label={props.title}
          aria-describedby={describedBy}
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          {rowContent}
        </button>
      ) : (
        <div className="timeline-row">{rowContent}</div>
      )}
      {props.children && <div className="timeline-row-body" hidden={!props.expanded}>{props.children}</div>}
    </section>
  );
}

function runStateLabel(state: RowState, t: ReturnType<typeof useI18n>["t"]): string {
  if (state === "running") return t("message.runState.running");
  if (state === "error") return t("message.runState.failed");
  if (state === "stopped") return t("message.runState.stopped");
  return "";
}

function sameTimelineDisplayRowProps(
  previous: TimelineDisplayRowProps,
  next: TimelineDisplayRowProps
): boolean {
  return previous.expanded === next.expanded
    && previous.live === next.live
    && previous.finalAnswer === next.finalAnswer
    && previous.hidden === next.hidden
    && previous.onCopyCode === next.onCopyCode
    && previous.onToggle === next.onToggle
    && sameTimelineDisplayItem(previous.item, next.item);
}

function sameTimelineDisplayItem(previous: TimelineDisplayItem, next: TimelineDisplayItem): boolean {
  if (previous.id !== next.id || previous.kind !== next.kind) return false;
  if (previous.kind === "thinking" || previous.kind === "tool_preamble" || previous.kind === "assistant_text") {
    return next.kind === previous.kind && previous.text === next.text;
  }
  if (previous.kind === "system") {
    return next.kind === "system" && previous.title === next.title && previous.text === next.text;
  }
  if (next.kind !== "tool") return false;
  const previousSummary = previous.summary;
  const nextSummary = next.summary;
  return previous.toolName === next.toolName
    && previous.call?.toolCallId === next.call?.toolCallId
    && previous.result?.toolCallId === next.result?.toolCallId
    && previousSummary.state === nextSummary.state
    && previousSummary.title === nextSummary.title
    && previousSummary.target === nextSummary.target
    && previousSummary.suffix === nextSummary.suffix
    && previousSummary.details.length === nextSummary.details.length
    && previousSummary.details.every((detail, index) => {
      const candidate = nextSummary.details[index];
      return detail.label === candidate.label
        && detail.content === candidate.content
        && detail.tone === candidate.tone;
    });
}

function recordTimelineRowRender(itemId: string): void {
  if (typeof window === "undefined" || !window.__JASMINE_HARNESS_ENABLED__) return;
  const renders = window.__JASMINE_TIMELINE_ROW_RENDERS__ ?? {};
  renders[itemId] = (renders[itemId] ?? 0) + 1;
  window.__JASMINE_TIMELINE_ROW_RENDERS__ = renders;
}

function compactTimelineItems(items: ChatTimelineItem[], live = false, modelId?: string | null): TimelineDisplayItem[] {
  const result: TimelineDisplayItem[] = [];
  const pendingTools = new Map<string, Array<{ displayIndex: number; timelineIndex: number }>>();
  const pendingToolsByCallId = new Map<string, { displayIndex: number; timelineIndex: number }>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === "thinking") {
      result.push({ id: item.id, kind: "thinking", text: item.text, defaultExpanded: false });
      continue;
    }
    if (item.kind === "tool_call") {
      const displayIndex = result.length;
      result.push(toToolDisplayItem(item, undefined, false));
      const queue = pendingTools.get(item.toolName) ?? [];
      const pending = { displayIndex, timelineIndex: index };
      queue.push(pending);
      pendingTools.set(item.toolName, queue);
      if (item.toolCallId) pendingToolsByCallId.set(item.toolCallId, pending);
      continue;
    }
    if (item.kind === "tool_result") {
      const pending = pendingTools.get(item.toolName);
      const byCallId = item.toolCallId ? pendingToolsByCallId.get(item.toolCallId) : undefined;
      // A correlated result must never be guessed onto a same-name call. The
      // matching call may arrive in a later provider snapshot; rendering the
      // result independently is stable, while a FIFO guess would visibly move
      // that output from call A to call B once the id appears.
      // A provider can expose a result before it exposes the correlation id.
      // FIFO is only unambiguous when exactly one same-name call is pending;
      // with parallel calls, render the result independently until a later
      // snapshot supplies its toolCallId instead of briefly attaching it to the
      // wrong row and then visibly moving it.
      const pair = item.toolCallId
        ? byCallId
        : pending?.length === 1
          ? pending.shift()
          : undefined;
      if (byCallId && pending) {
        const queueIndex = pending.indexOf(byCallId);
        if (queueIndex >= 0) pending.splice(queueIndex, 1);
      }
      if (item.toolCallId) pendingToolsByCallId.delete(item.toolCallId);
      if (pending && pending.length === 0) pendingTools.delete(item.toolName);
      if (pair) {
        const current = result[pair.displayIndex];
        if (current.kind === "tool") {
          result[pair.displayIndex] = toToolDisplayItem(current.call, item, false);
        }
        continue;
      }
      result.push(toToolDisplayItem(undefined, item));
      continue;
    }
    if (item.kind === "assistant_text") {
      // While a run is live, a text item cannot know whether a later tool call
      // will turn it into a DeepSeek tool preamble. Reclassifying a row after it
      // has painted remounts its Markdown and visibly jumps. Keep live text in
      // its first structure; a directly loaded settled turn can classify with
      // full context without changing an already-painted row.
      if (!live && isDeepSeekToolPreamble(items, index, modelId)) {
        result.push({ id: item.id, kind: "tool_preamble", text: item.text, defaultExpanded: false });
      } else {
        result.push({ id: item.id, kind: "assistant_text", text: item.text, defaultExpanded: true });
      }
      continue;
    }
    // Compaction, branch summaries, displayed custom messages, and any future
    // provider-owned system entry can contain arbitrary session text. Give all
    // of them their own deliberate disclosure; only Jasmine's nominal Stopped
    // status remains inline, with its summary sanitized again at render time.
    const collapsible = !isInlineSystemStatus(item.title);
    result.push({
      id: item.id,
      kind: "system",
      title: item.title,
      text: item.text,
      collapsible,
      defaultExpanded: !collapsible
    });
  }
  for (const pending of pendingTools.values()) {
    for (const pair of pending) {
      if (!hasStoppedSystemAfter(items, pair.timelineIndex)) continue;
      const current = result[pair.displayIndex];
      if (current.kind === "tool") {
        result[pair.displayIndex] = toToolDisplayItem(current.call, undefined, true);
      }
    }
  }
  return result;
}

function isDeepSeekToolPreamble(items: ChatTimelineItem[], textIndex: number, modelId?: string | null): boolean {
  if (!modelId?.toLowerCase().includes("deepseek-v4")) return false;

  let segmentStart = textIndex - 1;
  while (segmentStart >= 0 && items[segmentStart].kind !== "tool_result") segmentStart -= 1;
  const hasNativeThinking = items
    .slice(segmentStart + 1, textIndex)
    .some((item) => item.kind === "thinking" && item.text.trim().length > 0);
  if (hasNativeThinking) return false;

  for (let index = textIndex + 1; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind === "tool_call") return true;
    if (item.kind === "assistant_text" || item.kind === "thinking" || item.kind === "tool_result") return false;
  }
  return false;
}

function toToolDisplayItem(
  call: Extract<ChatTimelineItem, { kind: "tool_call" }> | undefined,
  toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined,
  stopped = false
): TimelineDisplayItem {
  const toolName = call?.toolName ?? toolResult?.toolName ?? "tool";
  const id = call?.id ?? toolResult?.id ?? `${toolName}-tool`;
  const summary = summarizeToolRun(toolName, call, toolResult, stopped);
  return {
    id,
    kind: "tool",
    toolName,
    call,
    result: toolResult,
    summary,
    defaultExpanded: false
  };
}

function ToolRunRow(props: {
  item: Extract<TimelineDisplayItem, { kind: "tool" }>;
  expanded: boolean;
  hidden: boolean;
  onToggle(): void;
}) {
  const { item } = props;
  const summary = item.summary;
  // Large tool outputs can be expensive even while hidden: mounting a
  // ShikiCodeBlock immediately starts language loading and highlighting. Keep
  // a never-opened row genuinely lazy, then retain the same detail subtree once
  // it has been visible so collapsing it (or settling a live row) does not throw
  // away the reader's DOM and highlighting work.
  const detailsMountedRef = useRef(props.expanded);
  if (props.expanded) detailsMountedRef.current = true;
  // A failed call's first error line replaces the target: it is the one thing
  // worth reading before deciding to open the row.
  const failureLine = summary.state === "error" ? toolFailureLine(item.result) : "";
  return (
    <TimelineRow
      itemId={item.id}
      className="tool-run-item"
      toolName={item.toolName}
      icon={toolIcon(item.toolName)}
      title={summary.title}
      summary={failureLine || summary.target}
      summaryTone={failureLine ? "error" : undefined}
      suffix={failureLine ? "" : summary.suffix}
      state={summary.state}
      expanded={props.expanded}
      hidden={props.hidden}
      onToggle={summary.details.length > 0 ? props.onToggle : undefined}
    >
      {detailsMountedRef.current && summary.details.length > 0 ? (
        <div className="tool-run-card">
          {summary.details.map((detail, index) => (
            <div key={detail.label} className="tool-run-section">
              {index > 0 && <span className="tool-run-divider" aria-hidden="true" />}
              <div className={`tool-run-slot ${detail.tone === "error" ? "error" : ""}`}>
                <small className="tool-run-slot-label">{detail.label}</small>
                <ShikiCodeBlock
                  code={detail.content}
                  language={toolDetailLanguage(item.toolName, detail, summary.target)}
                  kind={toolDetailKind(item.toolName, detail)}
                  showCopy={false}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </TimelineRow>
  );
}

function summarizeToolRun(
  toolName: string,
  call: Extract<ChatTimelineItem, { kind: "tool_call" }> | undefined,
  toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined,
  stopped = false
): ToolSummary {
  const args = parseArguments(call?.argumentsJson);
  const state: RowState = !toolResult
    ? (stopped ? "stopped" : "running")
    : toolResult.isError ? "error" : "done";
  return {
    state,
    title: toolTitle(toolName),
    target: toolTarget(toolName, args, call, toolResult),
    suffix: toolSuffix(toolName, args, toolResult),
    details: toolDetails(toolName, args, call, toolResult)
  };
}

// The tool's wire name, cased for display. Not localized: these name commands
// and capabilities, and a translated "Bash" would no longer identify the tool
// the reader can find in the transcript or the logs.
function toolTitle(toolName: string): string {
  if (toolName === "web_search") return "Search";
  if (toolName === "code_search") return "Code search";
  if (toolName === "fetch_content") return "Fetch";
  if (toolName === "get_search_content") return "Read search";
  if (toolName === "read") return "Read";
  if (toolName === "write") return "Write";
  if (toolName === "edit") return "Edit";
  if (toolName === "bash") return "Bash";
  return toolName;
}

function toolTarget(
  toolName: string,
  args: Record<string, unknown>,
  call: Extract<ChatTimelineItem, { kind: "tool_call" }> | undefined,
  toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined
): string {
  // Commands and queries can carry credentials, so they reach the row only
  // through credentialSafeText, which drops the whole value on any marker
  // rather than attempting to redact within it. URL tools keep a useful
  // origin/path while losing credentials, query, and hash.
  if (toolName === "bash") return safeCollapsedTextTarget(firstLine(stringValue(args.command) || call?.title || ""), 76);
  if (toolName === "web_search" || toolName === "code_search") {
    return safeCollapsedTextTarget(stringValue(args.query) || stringValue(args.q) || call?.title || "", 76);
  }
  if (toolName === "fetch_content") return sanitizedUrlTarget(stringValue(args.url), 76);
  if (toolName === "get_search_content") {
    const id = stringValue(args.id);
    return (/^https?:\/\//i.test(id) ? sanitizedUrlTarget(id, 76) : safeCollapsedTextTarget(id, 76))
      || sanitizedUrlTarget(stringValue(args.url), 76);
  }
  return safeCollapsedTextTarget(
    stringValue(args.path) ||
      stringValue(args.filePath) ||
      stringValue(args.filename) ||
      stringValue(args.targetPath) ||
      stringValue(args.sourcePath) ||
      call?.title ||
      toolResult?.title ||
      "",
    76
  );
}

// Only a mutation magnitude earns a slot beside the target: it tells the reader
// how much changed without opening the row. Byte totals and result counts are
// inspection detail and stay in the OUT section.
function toolSuffix(
  toolName: string,
  args: Record<string, unknown>,
  toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined
): string {
  if (!toolResult || toolResult.isError) return "";
  if (toolName === "edit") return diffStats(args, toolResult.content ?? "");
  if (toolName === "write") {
    const lineCount = lineCountOf(stringValue(args.content));
    return lineCount ? `+${lineCount}` : "";
  }
  return "";
}

function toolFailureLine(toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined): string {
  if (!toolResult) return "";
  const content = cleanedToolOutput(toolResult.content);
  const line = content.split("\n").map((entry) => entry.trim()).find(Boolean) ?? "";
  return truncateMiddle(credentialSafeText(line), 92);
}

function sanitizedUrlTarget(value: string, limit: number): string {
  return truncateMiddle(sanitizedHttpUrl(value), limit);
}

function safeCollapsedTextTarget(value: string, limit: number): string {
  return truncateMiddle(credentialSafeText(value), limit);
}

function firstLine(value: string): string {
  return value.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function isInlineSystemStatus(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === "stopped";
}

function localizedSystemTitle(title: string, t: ReturnType<typeof useI18n>["t"]): string {
  const normalized = title.trim().toLowerCase();
  if (normalized === "compaction") return t("message.compaction");
  if (normalized === "branch summary") return t("message.branchSummary");
  return title;
}

function hasStoppedSystemAfter(items: ChatTimelineItem[], index: number): boolean {
  return items.slice(index + 1).some((item) => item.kind === "system" && item.title.toLowerCase() === "stopped");
}

function toolDetails(
  toolName: string,
  args: Record<string, unknown>,
  call: Extract<ChatTimelineItem, { kind: "tool_call" }> | undefined,
  toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined
): ToolDetail[] {
  const details: ToolDetail[] = [];
  if (toolName === "bash") {
    const command = stringValue(args.command) || call?.title || "";
    if (command) details.push({ label: "IN", content: command, tone: "code" });
  } else if (call?.argumentsJson) {
    details.push({ label: "IN", content: compactArgumentsJson(args), tone: "code" });
  }
  if (toolResult) {
    const content = cleanedToolOutput(toolResult.content);
    if (content.trim()) {
      details.push({ label: "OUT", content, tone: toolResult.isError ? "error" : "code" });
    } else if (toolName === "bash") {
      details.push({ label: "OUT", content: "(no output)", tone: "code" });
    }
  }
  return details;
}

function toolDetailLanguage(toolName: string, detail: ToolDetail, target: string): string {
  if (detail.label === "IN") return toolName === "bash" ? commandLanguage(detail.content) : "json";
  if (detail.tone === "error") return looksLikeJson(detail.content) ? "json" : "ansi";
  if (toolName === "bash") return "ansi";
  if (toolName === "edit" || looksLikeDiff(detail.content)) return "diff";
  if (toolName === "read" || toolName === "write") return languageFromPath(target);
  if (looksLikeJson(detail.content)) return "json";
  return "text";
}

function toolDetailKind(toolName: string, detail: ToolDetail): CodeBlockKind {
  if (detail.label === "IN") return toolName === "bash" ? "ansi" : "json";
  if (detail.tone === "error") return "ansi";
  if (toolName === "bash") return "ansi";
  if (toolName === "edit" || looksLikeDiff(detail.content)) return "diff";
  if (looksLikeJson(detail.content)) return "json";
  return "code";
}

function commandLanguage(command: string): string {
  if (/\b(Get-ChildItem|Remove-Item|Select-Object|Where-Object|Write-Host)\b/i.test(command)) return "powershell";
  return "bash";
}

function compactArgumentsJson(args: Record<string, unknown>): string {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 500) {
      compacted[key] = `[${value.length} chars, ${lineCountOf(value)} lines]`;
    } else {
      compacted[key] = value;
    }
  }
  return JSON.stringify(compacted, null, 2);
}

function cleanedToolOutput(content: string): string {
  if (!content) return "";
  const replacementCount = (content.match(/�/g) ?? []).length;
  const visibleCount = content.replace(/\s/g, "").length;
  if (replacementCount >= 4 && replacementCount / Math.max(visibleCount, 1) > 0.18) {
    const exit = content.match(/Command exited with code \d+/)?.[0];
    return [exit ? "Output encoding could not be decoded." : "Output encoding could not be decoded.", exit].filter(Boolean).join("\n\n");
  }
  return content.trimEnd();
}

function diffStats(args: Record<string, unknown>, content: string): string {
  const diff = stringValue(args.diff) || content;
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
  }
  if (additions || removals) return `+${additions} −${removals}`;
  const oldText = stringValue(args.oldText);
  const newText = stringValue(args.newText);
  if (oldText || newText) return `+${lineCountOf(newText)} −${lineCountOf(oldText)}`;
  return "";
}

function parseArguments(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function lineCountOf(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(8, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function thoughtSummary(text: string, live: boolean): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return credentialSafeText((live ? lines.at(-1) : lines[0]) ?? "");
}

function toolIcon(toolName: string): ReactElement {
  if (toolName === "bash") return <TerminalIcon />;
  if (toolName === "edit") return <EditIcon />;
  if (toolName === "read" || toolName === "write") return <FileIcon />;
  if (toolName === "web_search" || toolName === "code_search" || toolName === "fetch_content" || toolName === "get_search_content") return <SearchIcon />;
  return <WrenchIcon />;
}
