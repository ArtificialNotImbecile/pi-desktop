import { memo, useCallback, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { ChatTimelineItem } from "../../../shared/ipc";
import { BrainIcon, ChevronDownIcon, SearchIcon, TerminalIcon, WrenchIcon } from "../icons/Icons";
import { MarkdownMessage } from "./MarkdownMessage";
import { useI18n } from "../../i18n";
import { languageFromPath, looksLikeDiff, looksLikeJson, ShikiCodeBlock, type CodeBlockKind } from "../code";
import { RunRecap, type RunRecapStatus } from "./RunRecap";

declare global {
  interface Window {
    __JASMINE_HARNESS_ENABLED__?: boolean;
    __JASMINE_TIMELINE_ROW_RENDERS__?: Record<string, number>;
  }
}

// A directly loaded settled recap stays lazy while collapsed. Rows that were
// already painted during a live run remain mounted (and are merely hidden) at
// settlement, so folding the recap never throws away already-rendered Markdown.
// A later thread reload can still remount a detail row, so mirror expansion
// toggles into this bounded cache rather than snapping it shut when rebuilt.
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
  recap?: {
    status: RunRecapStatus;
    elapsedMs?: number;
    defaultExpanded: boolean;
    header?: ReactNode;
    footer?: ReactNode;
  };
};

export function MessageTimeline(props: {
  cacheScope: string;
  items: ChatTimelineItem[];
  onCopyCode(code: string): void;
  live?: boolean;
  modelId?: string | null;
  settled?: SettledTimelinePresentation;
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
  const liveExpansionSnapshotRef = useRef<Record<string, boolean>>({});
  if (props.live) {
    for (const item of displayItems) {
      liveExpansionSnapshotRef.current[item.id] = expandedItems[item.id]
        ?? expansionStateCache.get(expansionKey(props.cacheScope, item.id))
        ?? item.defaultExpanded;
    }
  }
  const [recapExpandedOverride, setRecapExpandedOverride] = useState<boolean | null>(null);
  const recapExpanded = recapExpandedOverride ?? Boolean(props.settled?.recap?.defaultExpanded);
  const recapControlsBase = useId().replace(/:/g, "");
  const rowDomIds = useMemo(
    () => new Map(displayItems.map((item, index) => [item.id, `${recapControlsBase}-row-${index}`])),
    [displayItems, recapControlsBase]
  );
  const isExpanded = (item: TimelineDisplayItem) => expandedItems[item.id]
    ?? expansionStateCache.get(expansionKey(props.cacheScope, item.id))
    // Preserve an explicitly expanded live row for a reader-locked settlement,
    // but collapse ordinary successful recaps exactly as before.
    ?? (Boolean(props.settled) && recapExpanded && retainedLiveDetailsRef.current
      ? liveExpansionSnapshotRef.current[item.id] ?? item.defaultExpanded
      : Boolean(props.live) ? item.defaultExpanded : false);
  const toggleItem = useCallback((itemId: string, expanded: boolean) => {
    rememberExpansion(expansionKey(props.cacheScope, itemId), !expanded);
    setExpandedItems((current) => ({ ...current, [itemId]: !expanded }));
  }, [props.cacheScope]);

  const renderRows = (
    items: TimelineDisplayItem[],
    finalAnswer: boolean,
    hidden = false,
    domIds?: Map<string, string>
  ) => items.map((item) => (
    <TimelineDisplayRow
      key={item.id}
      domId={domIds?.get(item.id)}
      item={item}
      expanded={isExpanded(item)}
      live={retainPaintedPresentation}
      finalAnswer={finalAnswer}
      hidden={hidden}
      onCopyCode={props.onCopyCode}
      onToggle={toggleItem}
    />
  ));

  const children: ReactNode[] = [];
  if (!props.settled) {
    children.push(...renderRows(displayItems, false, false, rowDomIds));
  } else {
    const finalIds = new Set(props.settled.finalItemIds);
    if (props.settled.fallbackFinalItem) finalIds.add(props.settled.fallbackFinalItem.id);
    const details = displayItems.filter((item) => !finalIds.has(item.id));
    const finalItems = displayItems.filter((item) => finalIds.has(item.id));
    const recap = props.settled.recap;
    if (recap) {
      const headerId = `${recapControlsBase}-header`;
      const footerId = `${recapControlsBase}-footer`;
      const controlledIds = [headerId, ...details.map((item) => rowDomIds.get(item.id) ?? ""), footerId].filter(Boolean);
      children.push(
        <RunRecap
          key="run-recap"
          status={recap.status}
          elapsedMs={recap.elapsedMs}
          defaultExpanded={recap.defaultExpanded}
          expanded={recapExpanded}
          onExpandedChange={setRecapExpandedOverride}
          controlledIds={controlledIds}
        />
      );
      children.push(
        <div id={headerId} key="run-recap-header" hidden={!recapExpanded} className="run-recap-detail-row run-recap-meta">{recap.header}</div>
      );
      if (recapExpanded || retainedLiveDetailsRef.current) {
        children.push(...renderRows(details, false, !recapExpanded, rowDomIds));
      }
      children.push(
        <div id={footerId} key="run-recap-footer" hidden={!recapExpanded} className="run-recap-detail-row run-recap-provenance">{recap.footer}</div>
      );
    }
    // Keep rows in the same flat keyed child list across live -> settled. A
    // nested array creates a new reconciliation scope and remounts the final
    // Markdown subtree even though its item id is unchanged.
    children.push(...renderRows(finalItems, true, false, rowDomIds));
    if (!recap) children.push(...renderRows(details, false, false, rowDomIds));
  }

  return <div className="message-timeline">{children}</div>;
}

function expansionKey(scope: string, itemId: string): string {
  return `${scope}\u0000${itemId}`;
}

type TimelineDisplayItem =
  | { id: string; kind: "thinking"; text: string; defaultExpanded: boolean }
  | { id: string; kind: "tool_preamble"; text: string; defaultExpanded: boolean }
  | { id: string; kind: "tool"; toolName: string; call?: Extract<ChatTimelineItem, { kind: "tool_call" }>; result?: Extract<ChatTimelineItem, { kind: "tool_result" }>; summary: ToolSummary; defaultExpanded: boolean }
  | { id: string; kind: "assistant_text"; text: string; defaultExpanded: boolean }
  | { id: string; kind: "system"; title: string; text: string; defaultExpanded: boolean };

type ToolSummary = {
  state: "running" | "stopped" | "done" | "error";
  action: string;
  target: string;
  status: string;
  details: ToolDetail[];
};

type ToolDetail = { label: string; content: string; tone?: "error" | "code" };

type TimelineDisplayRowProps = {
  domId?: string;
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

  if (item.kind === "thinking") {
    return (
      <section id={props.domId} hidden={props.hidden} data-timeline-item-id={item.id} className={`timeline-item thinking-item ${props.expanded ? "" : "collapsed"}`} aria-label={t("message.thinking")}>
        <TimelineToggle label={t("message.thinking")} expanded={props.expanded} onToggle={toggle} icon={<BrainIcon />} />
        <div className="thinking-markdown" hidden={!props.expanded}>
          <MarkdownMessage content={item.text} onCopyCode={props.onCopyCode} streaming={props.live} />
        </div>
      </section>
    );
  }
  if (item.kind === "tool_preamble") {
    return (
      <section id={props.domId} hidden={props.hidden} data-timeline-item-id={item.id} className={`timeline-item thinking-item tool-preamble-item ${props.expanded ? "" : "collapsed"}`} aria-label={t("message.toolPreamble")}>
        <TimelineToggle label={t("message.toolPreamble")} expanded={props.expanded} onToggle={toggle} icon={<WrenchIcon />} />
        <div className="thinking-markdown" hidden={!props.expanded}>
          <MarkdownMessage content={item.text} onCopyCode={props.onCopyCode} streaming={props.live} />
        </div>
      </section>
    );
  }
  if (item.kind === "tool") {
    return <ToolRunRow id={props.domId} item={item} expanded={props.expanded} hidden={props.hidden} onToggle={toggle} />;
  }
  if (item.kind === "system") {
    return (
      <section id={props.domId} hidden={props.hidden} data-timeline-item-id={item.id} className="timeline-item system-item" aria-label={item.title}>
        <div className="timeline-label"><TerminalIcon /><span>{item.title}</span></div>
        <p>{item.text}</p>
      </section>
    );
  }
  return (
    <section
      id={props.domId}
      data-timeline-item-id={item.id}
      hidden={props.hidden}
      className={`timeline-output ${props.finalAnswer ? "final-answer" : ""}`}
      aria-label={t("message.assistantOutput")}
    >
      <MarkdownMessage content={item.text} onCopyCode={props.onCopyCode} streaming={props.live} />
    </section>
  );
}, sameTimelineDisplayRowProps);

function sameTimelineDisplayRowProps(
  previous: TimelineDisplayRowProps,
  next: TimelineDisplayRowProps
): boolean {
  return previous.expanded === next.expanded
    && previous.domId === next.domId
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
    && previousSummary.action === nextSummary.action
    && previousSummary.target === nextSummary.target
    && previousSummary.status === nextSummary.status
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
      result.push({ id: item.id, kind: "thinking", text: item.text, defaultExpanded: live });
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
      // its first structure; the settled recap can classify with full context.
      if (!live && isDeepSeekToolPreamble(items, index, modelId)) {
        result.push({ id: item.id, kind: "tool_preamble", text: item.text, defaultExpanded: live });
      } else {
        result.push({ id: item.id, kind: "assistant_text", text: item.text, defaultExpanded: true });
      }
      continue;
    }
    result.push({ id: item.id, kind: "system", title: item.title, text: item.text, defaultExpanded: true });
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
    defaultExpanded: summary.state === "error"
  };
}

function ToolRunRow(props: { id?: string; item: Extract<TimelineDisplayItem, { kind: "tool" }>; expanded: boolean; hidden?: boolean; onToggle(): void }) {
  const { item } = props;
  const summary = item.summary;
  // Large tool outputs can be expensive even while hidden: mounting a
  // ShikiCodeBlock immediately starts language loading and highlighting. Keep
  // a never-opened row genuinely lazy, then retain the same detail subtree once
  // it has been visible so collapsing it (or settling a live row) does not throw
  // away the reader's DOM and highlighting work.
  const detailsMountedRef = useRef(props.expanded);
  if (props.expanded) detailsMountedRef.current = true;
  return (
    <section
      id={props.id}
      data-timeline-item-id={item.id}
      hidden={props.hidden}
      className={`timeline-item tool-run-item ${summary.state} ${props.expanded ? "" : "collapsed"}`}
      aria-label={`Tool ${summary.action} ${summary.target}`.trim()}
    >
      <button type="button" className="timeline-label timeline-toggle tool-run-toggle" aria-expanded={props.expanded} onClick={props.onToggle}>
        {toolIcon(item.toolName)}
        <span className="tool-run-main">
          <b>{summary.action}</b>
          {summary.target && <span className="tool-run-target">{summary.target}</span>}
        </span>
        <small className={`tool-run-status ${summary.state}`}>{summary.status}</small>
        <ChevronDownIcon />
      </button>
      {detailsMountedRef.current ? (
        <div className="tool-run-details" hidden={!props.expanded}>
          {summary.details.map((detail) => (
            <div key={detail.label} className={detail.tone === "error" ? "error" : ""}>
              <small>{detail.label}</small>
              <ShikiCodeBlock
                code={detail.content}
                language={toolDetailLanguage(item.toolName, detail, summary.target)}
                kind={toolDetailKind(item.toolName, detail)}
                title={detail.label.toLowerCase()}
                showCopy={false}
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function summarizeToolRun(
  toolName: string,
  call: Extract<ChatTimelineItem, { kind: "tool_call" }> | undefined,
  toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined,
  stopped = false
): ToolSummary {
  const args = parseArguments(call?.argumentsJson);
  const state: ToolSummary["state"] = !toolResult ? (stopped ? "stopped" : "running") : toolResult.isError ? "error" : "done";
  const target = toolTarget(toolName, args, call, toolResult);
  const action = toolAction(toolName);
  const details = toolDetails(toolName, args, call, toolResult);
  const stats = toolStats(toolName, args, toolResult);
  return {
    state,
    action,
    target,
    status: toolStatus(toolName, state, stats, toolResult),
    details
  };
}

function toolAction(toolName: string): string {
  if (toolName === "web_search") return "search";
  if (toolName === "fetch_content") return "fetch";
  if (toolName === "get_search_content") return "read search";
  if (toolName === "code_search") return "code search";
  return toolName;
}

function toolTarget(
  toolName: string,
  args: Record<string, unknown>,
  call: Extract<ChatTimelineItem, { kind: "tool_call" }> | undefined,
  toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined
): string {
  if (toolName === "bash") return truncateMiddle(stringValue(args.command) || call?.title || toolResult?.title || "", 92);
  if (toolName === "web_search" || toolName === "code_search") return truncateMiddle(stringValue(args.query), 72);
  if (toolName === "fetch_content") return truncateMiddle(stringValue(args.url), 76);
  if (toolName === "get_search_content") return truncateMiddle(stringValue(args.id) || stringValue(args.url), 76);
  return truncateMiddle(
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

function toolStatus(
  toolName: string,
  state: ToolSummary["state"],
  stats: string,
  toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined
): string {
  if (state === "running") {
    if (toolName === "read" || toolName === "get_search_content") return "reading";
    if (toolName === "write") return "writing";
    if (toolName === "edit") return "editing";
    if (toolName === "bash") return "running";
    if (toolName.includes("search")) return "searching";
    if (toolName === "fetch_content") return "fetching";
    return "running";
  }
  if (state === "stopped") return "stopped";
  if (state === "error") {
    const exit = parseExitCode(toolResult?.content ?? "");
    return exit === null ? "failed" : `exit ${exit}`;
  }
  if (toolName === "read" || toolName === "get_search_content") return stats ? `read - ${stats}` : "read";
  if (toolName === "write") return stats ? `wrote - ${stats}` : "wrote";
  if (toolName === "edit") return stats ? `edited - ${stats}` : "edited";
  if (toolName === "bash") return stats ? `done - ${stats}` : "done";
  if (toolName.includes("search")) return stats ? `searched - ${stats}` : "searched";
  if (toolName === "fetch_content") return stats ? `fetched - ${stats}` : "fetched";
  return stats ? `done - ${stats}` : "done";
}

function hasStoppedSystemAfter(items: ChatTimelineItem[], index: number): boolean {
  return items.slice(index + 1).some((item) => item.kind === "system" && item.title.toLowerCase() === "stopped");
}

function toolStats(toolName: string, args: Record<string, unknown>, toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined): string {
  if (toolName === "write") {
    const lineCount = lineCountOf(stringValue(args.content));
    const bytes = parseByteCount(toolResult?.content ?? "");
    if (lineCount && bytes) return `${lineCount} lines, ${bytes} bytes`;
    if (lineCount) return `${lineCount} lines`;
    if (bytes) return `${bytes} bytes`;
  }
  if (toolName === "edit") {
    return diffStats(args, toolResult?.content ?? "");
  }
  if (toolName === "read" || toolName === "bash") {
    const content = cleanedToolOutput(toolResult?.content ?? "");
    const lines = lineCountOf(content);
    return lines ? `${lines} ${lines === 1 ? "line" : "lines"}` : "";
  }
  if (toolName === "web_search" || toolName === "code_search") {
    const content = cleanedToolOutput(toolResult?.content ?? "");
    const matches = content.match(/https?:\/\//g);
    return matches?.length ? `${matches.length} results` : "";
  }
  return "";
}

function toolDetails(
  toolName: string,
  args: Record<string, unknown>,
  call: Extract<ChatTimelineItem, { kind: "tool_call" }> | undefined,
  toolResult: Extract<ChatTimelineItem, { kind: "tool_result" }> | undefined
): ToolSummary["details"] {
  const details: ToolSummary["details"] = [];
  if (toolName === "bash") {
    const command = stringValue(args.command) || call?.title || "";
    if (command) details.push({ label: "COMMAND", content: command, tone: "code" });
  } else if (call?.argumentsJson) {
    details.push({ label: "INPUT", content: compactArgumentsJson(args), tone: "code" });
  }
  if (toolResult) {
    const content = cleanedToolOutput(toolResult.content);
    if (content.trim()) {
      details.push({ label: toolResult.isError ? "ERROR" : "OUTPUT", content, tone: toolResult.isError ? "error" : "code" });
    } else if (toolName === "bash") {
      details.push({ label: "OUTPUT", content: "(no output)", tone: "code" });
    }
  }
  return details;
}

function toolDetailLanguage(toolName: string, detail: ToolDetail, target: string): string {
  if (detail.label === "INPUT") return "json";
  if (detail.label === "COMMAND") return commandLanguage(detail.content);
  if (detail.label === "ERROR") return looksLikeJson(detail.content) ? "json" : "ansi";
  if (toolName === "bash") return "ansi";
  if (toolName === "edit" || looksLikeDiff(detail.content)) return "diff";
  if (toolName === "read" || toolName === "write") return languageFromPath(target);
  if (looksLikeJson(detail.content)) return "json";
  return "text";
}

function toolDetailKind(toolName: string, detail: ToolDetail): CodeBlockKind {
  if (detail.label === "INPUT") return "json";
  if (detail.label === "ERROR") return "ansi";
  if (toolName === "bash" || detail.label === "COMMAND") return "ansi";
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
  const replacementCount = (content.match(/\uFFFD/g) ?? []).length;
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
  if (additions || removals) return `+${additions} -${removals}`;
  const oldText = stringValue(args.oldText);
  const newText = stringValue(args.newText);
  if (oldText || newText) return `+${lineCountOf(newText)} -${lineCountOf(oldText)}`;
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

function parseByteCount(content: string): number | null {
  const match = content.match(/wrote\s+(\d+)\s+bytes/i) ?? content.match(/(\d+)\s+bytes/i);
  return match ? Number(match[1]) : null;
}

function parseExitCode(content: string): number | null {
  const match = content.match(/(?:exit code|code)\s+(\d+)/i);
  return match ? Number(match[1]) : null;
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

function TimelineToggle(props: { label: string; expanded: boolean; icon: ReactElement; onToggle(): void }) {
  return (
    <button type="button" className="timeline-label timeline-toggle" aria-expanded={props.expanded} onClick={props.onToggle}>
      {props.icon}
      <span>{props.label}</span>
      <ChevronDownIcon />
    </button>
  );
}

function toolIcon(toolName: string): ReactElement {
  if (toolName === "web_search" || toolName === "code_search" || toolName === "fetch_content" || toolName === "get_search_content") return <SearchIcon />;
  return <WrenchIcon />;
}
