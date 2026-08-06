import type { ChatStreamDelta, ChatStreamMessage, ChatStreamMessageDelta, ChatTimelineItem } from "./ipc.js";

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
    if (left.kind === "tool_call" && right.kind === "tool_call" && (left.title !== right.title || left.argumentsJson !== right.argumentsJson || left.toolName !== right.toolName)) return false;
    if (left.kind === "tool_result" && right.kind === "tool_result" && (left.title !== right.title || left.content !== right.content || left.toolName !== right.toolName || Boolean(left.isError) !== Boolean(right.isError))) return false;
    if (left.kind === "system" && right.kind === "system" && (left.title !== right.title || left.text !== right.text || left.customType !== right.customType)) return false;
  }
  return true;
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
      entry.timeline = cur.timeline;
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
    const timeline = change.timeline ?? prev.timeline;
    if (timeline !== undefined) merged.timeline = timeline;
    next[change.index] = merged;
  }
  return next;
}
