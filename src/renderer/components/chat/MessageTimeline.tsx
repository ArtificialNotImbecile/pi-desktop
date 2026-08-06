import { useMemo, useState, type ReactElement } from "react";
import type { ChatTimelineItem } from "../../../shared/ipc";
import { BrainIcon, ChevronDownIcon, SearchIcon, TerminalIcon, WrenchIcon } from "../icons/Icons";
import { MarkdownMessage } from "./MarkdownMessage";
import { useI18n } from "../../i18n";
import { languageFromPath, looksLikeDiff, looksLikeJson, ShikiCodeBlock, type CodeBlockKind } from "../code";

// At run end the live message (id `stream-<requestId>-N`) is replaced by the
// persisted row, remounting the timeline component. Timeline item ids are
// stable across that swap, so expansion toggles are mirrored into this bounded
// module-level cache to survive the remount; otherwise a row the user just
// expanded snaps shut when the database-backed refresh lands.
const expansionStateCache = new Map<string, boolean>();
const EXPANSION_CACHE_LIMIT = 500;

function rememberExpansion(itemId: string, expanded: boolean) {
  if (expansionStateCache.size >= EXPANSION_CACHE_LIMIT && !expansionStateCache.has(itemId)) {
    expansionStateCache.clear();
  }
  expansionStateCache.set(itemId, expanded);
}

export function MessageTimeline(props: { items: ChatTimelineItem[]; onCopyCode(code: string): void; live?: boolean }) {
  const { t } = useI18n();
  const displayItems = useMemo(() => compactTimelineItems(props.items, Boolean(props.live)), [props.items, props.live]);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const isExpanded = (item: TimelineDisplayItem) => expandedItems[item.id] ?? expansionStateCache.get(item.id) ?? item.defaultExpanded;
  const toggleItem = (item: TimelineDisplayItem, expanded: boolean) => {
    rememberExpansion(item.id, !expanded);
    setExpandedItems((current) => ({ ...current, [item.id]: !expanded }));
  };

  return (
    <div className="message-timeline">
      {displayItems.map((item) => {
        if (item.kind === "thinking") {
          const expanded = isExpanded(item);
          return (
            <section key={item.id} className={`timeline-item thinking-item ${expanded ? "" : "collapsed"}`} aria-label={t("message.thinking")}>
              <TimelineToggle label={t("message.thinking")} expanded={expanded} onToggle={() => toggleItem(item, expanded)} icon={<BrainIcon />} />
              {expanded && (
                <div className="thinking-markdown">
                  <MarkdownMessage content={item.text} onCopyCode={props.onCopyCode} />
                </div>
              )}
            </section>
          );
        }
        if (item.kind === "tool") {
          const expanded = isExpanded(item);
          return (
            <ToolRunRow key={item.id} item={item} expanded={expanded} onToggle={() => toggleItem(item, expanded)} />
          );
        }
        if (item.kind === "system") {
          return (
            <section key={item.id} className="timeline-item system-item" aria-label={item.title}>
              <div className="timeline-label"><TerminalIcon /><span>{item.title}</span></div>
              <p>{item.text}</p>
            </section>
          );
        }
        return (
          <section key={item.id} className="timeline-output" aria-label="Assistant output">
            <MarkdownMessage content={item.text} onCopyCode={props.onCopyCode} />
          </section>
        );
      })}
    </div>
  );
}

type TimelineDisplayItem =
  | { id: string; kind: "thinking"; text: string; defaultExpanded: boolean }
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

function compactTimelineItems(items: ChatTimelineItem[], live = false): TimelineDisplayItem[] {
  const result: TimelineDisplayItem[] = [];
  const pendingTools = new Map<string, Array<{ displayIndex: number; timelineIndex: number }>>();
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
      queue.push({ displayIndex, timelineIndex: index });
      pendingTools.set(item.toolName, queue);
      continue;
    }
    if (item.kind === "tool_result") {
      const pending = pendingTools.get(item.toolName);
      const pair = pending?.shift();
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
      result.push({ id: item.id, kind: "assistant_text", text: item.text, defaultExpanded: true });
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

function ToolRunRow(props: { item: Extract<TimelineDisplayItem, { kind: "tool" }>; expanded: boolean; onToggle(): void }) {
  const { item } = props;
  const summary = item.summary;
  return (
    <section
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
      {props.expanded && (
        <div className="tool-run-details">
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
      )}
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
