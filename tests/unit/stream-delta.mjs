import assert from "node:assert/strict";

const { applyStreamDelta, computeStreamDelta } = await import("../../dist/main/shared/streamDelta.js");
const { applyChatStreamSettlement, chatStreamPrefixRenderId, chatStreamRenderId, createChatStreamSettlement } = await import("../../dist/main/shared/streamSettlement.js");
const { chatSendRequestSchema } = await import("../../dist/main/shared/schemas.js");

function roundTrip(previous, current) {
  const delta = computeStreamDelta(previous, current);
  assert.notEqual(delta, null, "delta should be computable for growing streams");
  return applyStreamDelta(previous, delta);
}

// Plain content append produces an append delta, not a full copy.
{
  const previous = [{ role: "assistant", content: "Hello" }];
  const current = [{ role: "assistant", content: "Hello world" }];
  const delta = computeStreamDelta(previous, current);
  assert.equal(delta.messages.length, 1);
  assert.equal(delta.messages[0].contentAppend, " world");
  assert.equal(delta.messages[0].content, undefined);
  assert.deepEqual(applyStreamDelta(previous, delta), current);
}

// Unchanged flush produces an empty delta (sender skips these entirely).
{
  const snapshot = [{ role: "assistant", content: "Stable" }];
  const delta = computeStreamDelta(snapshot, [{ role: "assistant", content: "Stable" }]);
  assert.equal(delta.messages.length, 0);
  assert.equal(delta.messageCount, 1);
}

// Non-prefix rewrite falls back to full content replacement.
{
  const previous = [{ role: "assistant", content: "draft one" }];
  const current = [{ role: "assistant", content: "final" }];
  const delta = computeStreamDelta(previous, current);
  assert.equal(delta.messages[0].content, "final");
  assert.deepEqual(applyStreamDelta(previous, delta), current);
}

// New messages appended mid-run (multi-turn queue) arrive in full.
{
  const previous = [{ role: "assistant", content: "First answer" }];
  const current = [
    { role: "assistant", content: "First answer" },
    { role: "user", content: "Queued follow-up", attachments: [] },
    { role: "assistant", content: "Sec" }
  ];
  const merged = roundTrip(previous, current);
  assert.deepEqual(merged, current);
}

// Timeline growth (tool output) is carried and applied.
{
  const timelineA = [{ id: "t1", kind: "thinking", text: "hm" }];
  const timelineB = [
    { id: "t1", kind: "thinking", text: "hm" },
    { id: "t2", kind: "tool_call", toolName: "shell", title: "run", argumentsJson: "{}" }
  ];
  const previous = [{ role: "assistant", content: "x", timeline: timelineA }];
  const current = [{ role: "assistant", content: "x", timeline: timelineB }];
  const delta = computeStreamDelta(previous, current);
  assert.equal(delta.messages.length, 1);
  assert.equal(delta.messages[0].timelineDelta.items[0].item.id, "t2");
  assert.deepEqual(applyStreamDelta(previous, delta), current);
}

// Timeline item mutation in place (tool result content settles) is detected.
{
  const previous = [{ role: "assistant", content: "x", timeline: [{ id: "t1", kind: "tool_result", toolName: "shell", title: "run", content: "partial" }] }];
  const current = [{ role: "assistant", content: "x", timeline: [{ id: "t1", kind: "tool_result", toolName: "shell", title: "run", content: "partial + rest" }] }];
  const delta = computeStreamDelta(previous, current);
  assert.equal(delta.messages.length, 1);
  assert.deepEqual(applyStreamDelta(previous, delta), current);
}

// Growing timeline text is appended instead of cloning the full cumulative
// thinking/answer on every tick. This is the shape from the reported 15k+
// native-thinking recording.
{
  const prefix = "reasoning ".repeat(10_000);
  const suffix = "new tail only";
  const previous = [{ role: "assistant", content: "", timeline: [{ id: "thinking-long", kind: "thinking", text: prefix }] }];
  const current = [{ role: "assistant", content: "", timeline: [{ id: "thinking-long", kind: "thinking", text: prefix + suffix }] }];
  const delta = computeStreamDelta(previous, current);
  assert.equal(delta.messages[0].timeline, undefined);
  assert.equal(delta.messages[0].timelineDelta.items[0].textAppend, suffix);
  assert.ok(JSON.stringify(delta).length < 300, "delta must not repeat the 100KB prefix");
  assert.deepEqual(applyStreamDelta(previous, delta), current);
}

// Appending a new timeline item and growing its text can both round-trip.
{
  const previous = [{ role: "assistant", content: "x", timeline: [{ id: "answer", kind: "assistant_text", text: "hello" }] }];
  const current = [{ role: "assistant", content: "x", timeline: [
    { id: "answer", kind: "assistant_text", text: "hello world" },
    { id: "call", kind: "tool_call", toolCallId: "c1", toolName: "read", title: "read", argumentsJson: "{\"path\":\"a\"}" }
  ] }];
  const delta = computeStreamDelta(previous, current);
  assert.equal(delta.messages[0].timelineDelta.items[0].textAppend, " world");
  assert.equal(delta.messages[0].timelineDelta.items[1].item.id, "call");
  assert.deepEqual(applyStreamDelta(previous, delta), current);
}

// Tool correlation is observable timeline state: a late correlation id must
// not be swallowed as an unchanged flush when parallel same-name tools exist.
{
  const previous = [{ role: "assistant", content: "x", timeline: [{ id: "t1", kind: "tool_result", toolName: "read", title: "read", content: "done" }] }];
  const current = [{ role: "assistant", content: "x", timeline: [{ id: "t1", kind: "tool_result", toolCallId: "call-b", toolName: "read", title: "read", content: "done" }] }];
  const delta = computeStreamDelta(previous, current);
  assert.equal(delta.messages.length, 1);
  assert.deepEqual(applyStreamDelta(previous, delta), current);
}

// IPC validation must preserve provider correlation ids. Zod strips unknown
// object fields, so omitting these keys from the shared schema silently reduced
// parallel same-name tools back to ambiguous FIFO matching.
{
  const parsed = chatSendRequestSchema.parse({
    threadId: "schema-tool-correlation",
    messages: [{
      role: "assistant",
      content: "",
      timeline: [
        { id: "call-row", kind: "tool_call", toolCallId: "call-b", toolName: "read", title: "read", argumentsJson: "{}" },
        { id: "result-row", kind: "tool_result", toolCallId: "call-b", toolName: "read", title: "read", content: "done" }
      ]
    }],
    content: "continue"
  });
  assert.deepEqual(parsed.messages[0].timeline.map((item) => item.toolCallId), ["call-b", "call-b"]);
}

// A shrinking message list cannot be expressed as a delta.
{
  const previous = [
    { role: "assistant", content: "a" },
    { role: "assistant", content: "b" }
  ];
  const current = [{ role: "assistant", content: "a" }];
  assert.equal(computeStreamDelta(previous, current), null);
}

// Applying a delta never mutates the base snapshot (renderer keeps it by ref).
{
  const previous = [{ role: "assistant", content: "Hello" }];
  const frozen = JSON.parse(JSON.stringify(previous));
  const delta = computeStreamDelta(previous, [{ role: "assistant", content: "Hello!" }]);
  applyStreamDelta(previous, delta);
  assert.deepEqual(previous, frozen);
}

// Out-of-range indices in a malformed delta are ignored instead of crashing.
{
  const base = [{ role: "assistant", content: "safe" }];
  const merged = applyStreamDelta(base, { messageCount: 1, messages: [{ index: 5, role: "assistant", contentAppend: "!" }] });
  assert.deepEqual(merged, base);
}

// Simulated long stream: many append ticks reconstruct the exact final text.
{
  let snapshot = [{ role: "assistant", content: "" }];
  let full = "";
  for (let i = 0; i < 200; i += 1) {
    const nextFull = full + `token${i} `;
    const current = [{ role: "assistant", content: nextFull }];
    const delta = computeStreamDelta(snapshot, current);
    snapshot = applyStreamDelta(snapshot, delta);
    full = nextFull;
  }
  assert.equal(snapshot[0].content, full);
}

// Settlement carries persisted rows while preserving the live row identities in
// runtime order, including queued user/assistant turns.
{
  const prefix = [{ id: "persisted-user", threadId: "thread-1", role: "user", content: "Prompt", createdAt: "2026-01-01T00:00:00.000Z" }];
  const runtimeMessages = [
    { id: "assistant-1", threadId: "thread-1", role: "assistant", content: "First", createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "queued-user", threadId: "thread-1", role: "user", content: "Follow up", createdAt: "2026-01-01T00:00:02.000Z" },
    { id: "assistant-2", threadId: "thread-1", role: "assistant", content: "Second", createdAt: "2026-01-01T00:00:03.000Z" }
  ];
  const settlement = createChatStreamSettlement("request-1", "anchor-1", prefix, runtimeMessages, true);
  assert.equal(settlement.replaceAfterMessageId, "anchor-1");
  assert.equal("replaceFromMessageId" in settlement, false);
  assert.equal(settlement.messages[0].renderId, "pending-request-1-0");
  assert.equal(chatStreamPrefixRenderId("request-1", 2), "pending-request-1-2");
  assert.deepEqual(
    settlement.messages.slice(1).map((message) => ({ id: message.id, renderId: message.renderId })),
    [
      { id: "assistant-1", renderId: "stream-request-1-0" },
      { id: "queued-user", renderId: "stream-request-1-1" },
      { id: "assistant-2", renderId: "stream-request-1-2" }
    ]
  );
  assert.equal(chatStreamRenderId("request-1", 2), "stream-request-1-2");
  assert.equal(runtimeMessages.some((message) => "renderId" in message), false, "input rows are not mutated");

  const current = [
    { id: "history", threadId: "thread-1", role: "assistant", content: "History", createdAt: "2025-12-31T23:59:58.000Z" },
    { id: "anchor-1", threadId: "thread-1", role: "user", content: "Anchor", createdAt: "2025-12-31T23:59:59.000Z" },
    { id: "pending", threadId: "thread-1", role: "user", content: "Optimistic", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "stream-request-1-0", threadId: "thread-1", role: "assistant", content: "Live", createdAt: "2026-01-01T00:00:01.000Z" }
  ];
  const applied = applyChatStreamSettlement(current, settlement);
  assert.equal(applied[0], current[0], "settled history keeps its object identity");
  assert.equal(applied[1], current[1], "the anchor keeps its object identity");
  assert.deepEqual(applied.slice(2), settlement.messages);
}

// If a paged renderer no longer contains the settlement anchor, retain older
// authoritative rows instead of replacing the whole visible conversation with
// the run tail.
{
  const current = [
    { id: "older", threadId: "thread-1", role: "assistant", content: "Older", createdAt: "2025-12-31T23:59:00.000Z" },
    { id: "pending-request-2-0", threadId: "thread-1", role: "user", content: "Optimistic", createdAt: "2026-01-01T00:00:00.000Z" }
  ];
  const settlement = createChatStreamSettlement("request-2", "missing-anchor", [{
    id: "persisted-user",
    threadId: "thread-1",
    role: "user",
    content: "Prompt",
    createdAt: "2026-01-01T00:00:00.000Z"
  }], []);
  const applied = applyChatStreamSettlement(current, settlement);
  assert.equal(applied[0], current[0]);
  assert.deepEqual(applied.slice(1), settlement.messages);
}

// Missing-anchor fallback splices at the first settled id/renderId instead of
// comparing timestamps; persisted rows can legitimately share a millisecond.
{
  const sameTimestamp = "2026-01-01T00:00:00.000Z";
  const settlement = createChatStreamSettlement("request-3", "missing-anchor", [], [{
    id: "persisted-assistant",
    threadId: "thread-1",
    role: "assistant",
    content: "Done",
    createdAt: sameTimestamp
  }]);
  const current = [
    { id: "legal-prefix", threadId: "thread-1", role: "user", content: "Keep", createdAt: sameTimestamp },
    { id: "stream-request-3-0", renderId: "stream-request-3-0", threadId: "thread-1", role: "assistant", content: "Live", createdAt: sameTimestamp }
  ];
  const applied = applyChatStreamSettlement(current, settlement);
  assert.equal(applied[0], current[0], "same-millisecond prefix is retained");
  assert.deepEqual(applied.slice(1), settlement.messages);
}

// If retry's retained anchor is outside the loaded page, use the explicit first
// superseded id to remove a stable stale assistant before appending its replacement.
{
  const staleTarget = {
    id: "assistant-to-replace",
    renderId: "stream-old-request-0",
    threadId: "thread-1",
    role: "assistant",
    content: "Stale reply",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  const current = [
    staleTarget,
    { id: "newer-stale-user", threadId: "thread-1", role: "user", content: "Stale tail", createdAt: "2026-01-01T00:00:01.000Z" }
  ];
  const settlement = createChatStreamSettlement("paged-retry", "off-page-anchor", [], [{
    id: "replacement-assistant",
    threadId: "thread-1",
    role: "assistant",
    content: "Fresh reply",
    createdAt: "2026-01-01T00:00:02.000Z"
  }], false, staleTarget.id);
  assert.equal(settlement.replaceFromMessageId, staleTarget.id);
  const applied = applyChatStreamSettlement(current, settlement);
  assert.deepEqual(applied, settlement.messages);
}

// Database-backed edit/abort snapshots without an explicit renderId inherit the
// current row identity, keeping already-settled DOM nodes mounted.
{
  const current = [
    { id: "persisted-user", renderId: "pending-send-0", threadId: "thread-1", role: "user", content: "Before edit", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "persisted-assistant", renderId: "stream-send-0", threadId: "thread-1", role: "assistant", content: "Before abort", createdAt: "2026-01-01T00:00:01.000Z" }
  ];
  const applied = applyChatStreamSettlement(current, {
    messages: [
      { ...current[0], renderId: undefined, content: "After edit" },
      { ...current[1], renderId: undefined, content: "After abort" }
    ]
  });
  assert.equal(applied[0].renderId, "pending-send-0");
  assert.equal(applied[1].renderId, "stream-send-0");
}

// Operation-specific abort settlements splice only their own tail. This models
// a renderer that loaded more than the database page cap before the user stops
// a send/retry/edit before its first runtime chunk.
{
  const history = Array.from({ length: 620 }, (_, index) => ({
    id: `history-${index}`,
    threadId: "long-thread",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `History ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
  }));

  const optimisticSend = {
    id: "pending-abort-send-0",
    renderId: "pending-abort-send-0",
    threadId: "long-thread",
    role: "user",
    content: "Stop before first chunk",
    createdAt: "2026-01-01T01:00:00.000Z"
  };
  const persistedSend = { ...optimisticSend, id: "persisted-send", renderId: undefined };
  const sendSettlement = createChatStreamSettlement(
    "abort-send",
    history.at(-1).id,
    [persistedSend],
    [],
    true
  );
  const sent = applyChatStreamSettlement([...history, optimisticSend], sendSettlement);
  assert.equal(sent.length, 621);
  assert.equal(sent[0], history[0], "send abort keeps history older than the 500-row page cap");
  assert.equal(sent[619], history[619]);
  assert.equal(sent.at(-1).id, "persisted-send");
  assert.equal(sent.at(-1).renderId, optimisticSend.renderId, "persisted send keeps the optimistic DOM key");

  const retryAnchor = history.at(-2);
  const staleAssistant = history.at(-1);
  const liveRetry = {
    ...staleAssistant,
    id: "stream-abort-retry-0",
    renderId: "stream-abort-retry-0",
    content: "Partial retry"
  };
  const retrySettlement = createChatStreamSettlement(
    "abort-retry",
    retryAnchor.id,
    [],
    [staleAssistant],
    false,
    staleAssistant.id
  );
  const retried = applyChatStreamSettlement([...history.slice(0, -1), liveRetry], retrySettlement);
  assert.equal(retried[0], history[0]);
  assert.equal(retried.at(-1).id, staleAssistant.id);
  assert.equal(retried.at(-1).renderId, liveRetry.renderId, "restored retry target keeps the live DOM key");

  const editIndex = 610;
  const editedUser = {
    ...history[editIndex],
    renderId: "pending-original-send-0",
    content: "Optimistic edit"
  };
  const editSettlement = createChatStreamSettlement(
    "abort-edit",
    history[editIndex - 1].id,
    history.slice(editIndex),
    [],
    false,
    history[editIndex].id
  );
  const edited = applyChatStreamSettlement([...history.slice(0, editIndex), editedUser], editSettlement);
  assert.equal(edited.length, history.length);
  assert.equal(edited[0], history[0]);
  assert.equal(edited[editIndex].id, history[editIndex].id);
  assert.equal(edited[editIndex].renderId, editedUser.renderId, "restored edit target keeps its existing DOM key");
  assert.equal(edited.at(-1).id, history.at(-1).id);
}

// An initial run has no anchor and atomically replaces the currently loaded tail.
{
  const settlement = createChatStreamSettlement("initial", undefined, [], [{
    id: "assistant",
    threadId: "thread-1",
    role: "assistant",
    content: "Done",
    createdAt: "2026-01-01T00:00:00.000Z"
  }]);
  assert.equal("replaceAfterMessageId" in settlement, false);
  assert.equal(settlement.messages[0].renderId, "stream-initial-0");
}

console.log("stream-delta: all assertions passed");
