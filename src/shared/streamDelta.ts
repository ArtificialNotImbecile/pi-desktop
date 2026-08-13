import type { ChatStreamDelta, ChatStreamMessage, ChatStreamMessageDelta, ChatTimelineDelta, ChatTimelineItem } from "./ipc.js";

// Delta computation/application for streaming chat updates. The main process
// computes a delta between consecutive throttled flushes and the renderer
// reconstructs the full live-message array from its last snapshot. Keeping both
// halves in one shared module guarantees they stay inverse operations and lets
// unit tests exercise compute→apply round trips directly.

function sameStreamTimeline(previous: ChatTimelineItem[] | undefined, next: ChatTimelineItem[] | undefined): boolean {
  const a = previous ?? [];
  const b = next ?? [];
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left.id !== right.id || left.kind !== right.kind) return false;
    if (left.kind === "thinking" && right.kind === "thinking" && left.text !== right.text) return false;
    if (left.kind === "assistant_text" && right.kind === "assistant_text" && left.text !== right.text) return false;
    if (left.kind === "tool_call" && right.kind === "tool_call" && (left.toolCallId !== right.toolCallId || left.title !== right.title || left.argumentsJson !== right.argumentsJson || left.toolName !== right.toolName)) return false;
    if (left.kind === "tool_result" && right.kind === "tool_result" && (left.toolCallId !== right.toolCallId || left.title !== right.title || left.content !== right.content || left.toolName !== right.toolName || Boolean(left.isError) !== Boolean(right.isError))) return false;
    if (left.kind === "system" && right.kind === "system" && (left.title !== right.title || left.text !== right.text || left.customType !== right.customType)) return false;
  }
  return true;
}

function computeTimelineDelta(previous: ChatTimelineItem[] | undefined, current: ChatTimelineItem[] | undefined): ChatTimelineDelta | null {
  const before = previous ?? [];
  const after = current ?? [];
  if (after.length < before.length) return null;
  const items: ChatTimelineDelta["items"] = [];
  for (let index = 0; index < after.length; index += 1) {
    const next = after[index];
    const prior = before[index];
    if (!prior || prior.id !== next.id || prior.kind !== next.kind) {
      items.push({ index, item: next });
      continue;
    }
    if (next.kind === "thinking" && prior.kind === "thinking") {
      if (next.text !== prior.text) items.push(next.text.startsWith(prior.text)
        ? { index, textAppend: next.text.slice(prior.text.length) }
        : { index, item: next });
      continue;
    }
    if (next.kind === "assistant_text" && prior.kind === "assistant_text") {
      if (next.text !== prior.text) items.push(next.text.startsWith(prior.text)
        ? { index, textAppend: next.text.slice(prior.text.length) }
        : { index, item: next });
      continue;
    }
    if (next.kind === "tool_call" && prior.kind === "tool_call") {
      const stable = next.toolCallId === prior.toolCallId && next.title === prior.title && next.toolName === prior.toolName;
      if (!stable) items.push({ index, item: next });
      else if (next.argumentsJson !== prior.argumentsJson) items.push(next.argumentsJson.startsWith(prior.argumentsJson)
        ? { index, argumentsJsonAppend: next.argumentsJson.slice(prior.argumentsJson.length) }
        : { index, item: next });
      continue;
    }
    if (next.kind === "tool_result" && prior.kind === "tool_result") {
      const stable = next.toolCallId === prior.toolCallId
        && next.title === prior.title
        && next.toolName === prior.toolName
        && Boolean(next.isError) === Boolean(prior.isError);
      if (!stable) items.push({ index, item: next });
      else if (next.content !== prior.content) items.push(next.content.startsWith(prior.content)
        ? { index, contentAppend: next.content.slice(prior.content.length) }
        : { index, item: next });
      continue;
    }
    if (next.kind === "system" && prior.kind === "system") {
      const stable = next.title === prior.title && next.customType === prior.customType;
      if (!stable) items.push({ index, item: next });
      else if (next.text !== prior.text) items.push(next.text.startsWith(prior.text)
        ? { index, textAppend: next.text.slice(prior.text.length) }
        : { index, item: next });
    }
  }
  return { itemCount: after.length, items };
}

function applyTimelineDelta(previous: ChatTimelineItem[] | undefined, delta: ChatTimelineDelta): ChatTimelineItem[] | null {
  const next = (previous ?? []).slice(0, delta.itemCount);
  for (const change of delta.items) {
    if (change.index < 0 || change.index >= delta.itemCount) continue;
    if (change.item) {
      next[change.index] = change.item;
      continue;
    }
    const prior = next[change.index];
    if (!prior) return null;
    if ((prior.kind === "thinking" || prior.kind === "assistant_text" || prior.kind === "system") && change.textAppend !== undefined) {
      next[change.index] = { ...prior, text: prior.text + change.textAppend };
    } else if (prior.kind === "tool_call" && change.argumentsJsonAppend !== undefined) {
      next[change.index] = { ...prior, argumentsJson: prior.argumentsJson + change.argumentsJsonAppend };
    } else if (prior.kind === "tool_result" && change.contentAppend !== undefined) {
      next[change.index] = { ...prior, content: prior.content + change.contentAppend };
    }
  }
  return next.length === delta.itemCount && next.every(Boolean) ? next : null;
}

// Returns null when a delta cannot represent the transition (shrinking message
// list); callers must fall back to sending a full snapshot.
export function computeStreamDelta(previous: ChatStreamMessage[], current: ChatStreamMessage[]): ChatStreamDelta | null {
  if (current.length < previous.length) return null;
  const messages: ChatStreamMessageDelta[] = [];
  for (let index = 0; index < current.length; index += 1) {
    const cur = current[index];
    const prev = previous[index];
    if (!prev) {
      messages.push({ index, role: cur.role, content: cur.content, attachments: cur.attachments, timeline: cur.timeline });
      continue;
    }
    const entry: ChatStreamMessageDelta = { index, role: cur.role };
    let changed = false;
    if (cur.content !== prev.content) {
      if (cur.content.length >= prev.content.length && cur.content.startsWith(prev.content)) {
        entry.contentAppend = cur.content.slice(prev.content.length);
      } else {
        entry.content = cur.content;
      }
      changed = true;
    }
    if (!sameStreamTimeline(prev.timeline, cur.timeline)) {
      const timelineDelta = computeTimelineDelta(prev.timeline, cur.timeline);
      if (timelineDelta) entry.timelineDelta = timelineDelta;
      else entry.timeline = cur.timeline;
      changed = true;
    }
    if (changed) messages.push(entry);
  }
  return { messageCount: current.length, messages };
}

export function applyStreamDelta(base: ChatStreamMessage[], delta: ChatStreamDelta): ChatStreamMessage[] {
  const next: ChatStreamMessage[] = base.slice(0, delta.messageCount);
  while (next.length < delta.messageCount) {
    next.push({ role: "assistant", content: "" });
  }
  for (const change of delta.messages) {
    if (change.index < 0 || change.index >= delta.messageCount) continue;
    const prev = next[change.index];
    const merged: ChatStreamMessage = {
      role: change.role,
      content: change.content !== undefined ? change.content : prev.content + (change.contentAppend ?? "")
    };
    const attachments = change.attachments ?? prev.attachments;
    if (attachments !== undefined) merged.attachments = attachments;
    const patchedTimeline = change.timelineDelta ? applyTimelineDelta(prev.timeline, change.timelineDelta) : null;
    const timeline = change.timeline ?? patchedTimeline ?? prev.timeline;
    if (timeline !== undefined) merged.timeline = timeline;
    next[change.index] = merged;
  }
  return next;
}
