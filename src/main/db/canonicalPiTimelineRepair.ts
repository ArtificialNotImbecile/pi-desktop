import { existsSync, readFileSync } from "node:fs";
import type { ChatTimelineItem } from "../../shared/ipc.js";

export type CanonicalPiBlock = {
  type: "thinking" | "text";
  text: string;
  entryId: string;
};

export type CanonicalPiBlockIndex = {
  sessionId: string;
  blocks: Map<string, CanonicalPiBlock>;
  parentByEntryId: Map<string, string | null>;
  anchorEligibleEntryIds: Set<string>;
  userEntryIds: Set<string>;
};

export type CanonicalTimelineRepair = {
  timeline: ChatTimelineItem[];
  content: string;
  changed: boolean;
  resolved: boolean;
};

const V28_SYNTHETIC_THINKING_LEVEL_ID = "deepseek-thinking-level-repair";

export function readCanonicalPiBlockIndex(sessionFile: string): CanonicalPiBlockIndex | null {
  if (!existsSync(sessionFile)) return null;
  try {
    return canonicalPiBlockIndexFromJsonl(readFileSync(sessionFile, "utf8"));
  } catch {
    return null;
  }
}

export function canonicalPiBlockIndexFromJsonl(source: string): CanonicalPiBlockIndex | null {
  let sessionId = "";
  const blocks = new Map<string, CanonicalPiBlock>();
  const parentByEntryId = new Map<string, string | null>();
  const anchorEligibleEntryIds = new Set<string>();
  const userEntryIds = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (value.type === "session" && typeof value.id === "string") {
      if (sessionId && sessionId !== value.id) return null;
      sessionId = value.id;
      continue;
    }
    if (typeof value.id === "string") {
      if (parentByEntryId.has(value.id)) return null;
      parentByEntryId.set(value.id, typeof value.parentId === "string" ? value.parentId : null);
      if (isTimelineAnchorEligible(value)) anchorEligibleEntryIds.add(value.id);
    }
    if (value.type !== "message" || typeof value.id !== "string" || !value.message || typeof value.message !== "object") continue;
    const message = value.message as Record<string, unknown>;
    if (message.role === "user") userEntryIds.add(value.id);
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [message.content];
    content.forEach((block, index) => {
      if (!block || typeof block !== "object") return;
      const item = block as Record<string, unknown>;
      const blockId = `${value.id}-${index}`;
      if (blocks.has(blockId)) return;
      if (item.type === "thinking" && typeof item.thinking === "string") {
        blocks.set(blockId, { type: "thinking", text: item.thinking, entryId: value.id as string });
      }
      if (item.type === "text" && typeof item.text === "string") {
        blocks.set(blockId, { type: "text", text: item.text, entryId: value.id as string });
      }
    });
  }
  return sessionId ? { sessionId, blocks, parentByEntryId, anchorEligibleEntryIds, userEntryIds } : null;
}

/**
 * Restores SQLite's UI/search projection from the canonical Pi JSONL block
 * types. This reverses the old v28 heuristic without touching the JSONL or
 * guessing whether provider `content` was private reasoning.
 */
export function restoreCanonicalPiTimelineProjection(
  timeline: ChatTimelineItem[],
  fallbackContent: string,
  canonical: CanonicalPiBlockIndex,
  sessionEntryId: string
): CanonicalTimelineRepair {
  // Mirror the runtime's possible timeline-producing anchors. This includes
  // model/thinking/custom/tool metadata, not just assistant messages, while
  // rejecting a stale user or invisible entry binding.
  if (!canonical.anchorEligibleEntryIds.has(sessionEntryId)) {
    return { timeline, content: fallbackContent, changed: false, resolved: false };
  }

  // A bound Pi thinking item must be provably owned by this assistant run.
  // If the link is stale or the JSONL projection no longer matches, leave the
  // whole row untouched and let the migration retry after the source is fixed.
  for (const item of timeline) {
    if (item.kind !== "thinking") continue;
    const block = canonical.blocks.get(item.id);
    if (!block || block.text !== item.text || !belongsToAssistantRun(block.entryId, sessionEntryId, canonical)) {
      return { timeline, content: fallbackContent, changed: false, resolved: false };
    }
  }

  let semanticChange = false;
  let changed = false;
  const repaired = timeline.flatMap((item): ChatTimelineItem[] => {
    if (item.kind === "system" && item.id === V28_SYNTHETIC_THINKING_LEVEL_ID) {
      changed = true;
      return [];
    }
    // v28 only changed provider `text` blocks from assistant_text to thinking.
    // Reverse exactly that direction; never infer a new Thinking block here.
    if (item.kind !== "thinking") return [item];
    const block = canonical.blocks.get(item.id);
    if (!block || block.type !== "text" || block.text !== item.text || !belongsToAssistantRun(block.entryId, sessionEntryId, canonical)) return [item];
    changed = true;
    semanticChange = true;
    return [{ id: item.id, kind: "assistant_text", text: item.text } as ChatTimelineItem];
  });

  if (!changed) return { timeline, content: fallbackContent, changed: false, resolved: true };
  const content = semanticChange
    ? repaired
        .filter((item): item is Extract<ChatTimelineItem, { kind: "assistant_text" }> => item.kind === "assistant_text")
        .map((item) => item.text.trim())
        .filter(Boolean)
        .join("\n")
        .trim()
    : fallbackContent;
  return { timeline: repaired, content, changed: true, resolved: true };
}

function isTimelineAnchorEligible(entry: Record<string, unknown>): boolean {
  if (["thinking_level_change", "model_change", "compaction", "branch_summary", "custom"].includes(String(entry.type))) {
    return true;
  }
  if (entry.type === "custom_message") return Boolean(entry.display);
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return false;
  const message = entry.message as Record<string, unknown>;
  if (message.role === "toolResult" || message.role === "bashExecution") return true;
  if (message.role === "custom") return message.display !== false;
  if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
  return message.content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const value = block as Record<string, unknown>;
    if (value.type === "thinking" || value.type === "toolCall") return true;
    return value.type === "text" && typeof value.text === "string" && value.text.trim().length > 0;
  });
}

function belongsToAssistantRun(entryId: string, startEntryId: string, canonical: CanonicalPiBlockIndex): boolean {
  const visited = new Set<string>();
  let current: string | null | undefined = entryId;
  while (current) {
    if (visited.has(current)) return false;
    visited.add(current);
    if (canonical.userEntryIds.has(current)) return false;
    if (current === startEntryId) return true;
    current = canonical.parentByEntryId.get(current);
  }
  return false;
}
