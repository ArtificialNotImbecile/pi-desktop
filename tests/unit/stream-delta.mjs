import assert from "node:assert/strict";

const { applyStreamDelta, computeStreamDelta } = await import("../../dist/main/shared/streamDelta.js");

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
  assert.deepEqual(delta.messages[0].timeline, timelineB);
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

console.log("stream-delta: all assertions passed");
