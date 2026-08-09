import assert from "node:assert/strict";
import { SessionManager, estimateTokens } from "@earendil-works/pi-coding-agent";
import { calculatePiContextUsage } from "../../dist/main/main/services/piContextUsage.js";

function appendAssistant(manager, totalTokens, stopReason = "stop") {
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture reply" }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason,
    timestamp: Date.now()
  });
}

const manager = SessionManager.inMemory(process.cwd());
manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
appendAssistant(manager, 420);
assert.deepEqual(calculatePiContextUsage(manager, 1000), {
  tokens: 420,
  contextWindow: 1000,
  percent: 42
});

manager.appendMessage({ role: "user", content: "trailing prompt after the last provider usage", timestamp: Date.now() });
const messagesWithTrailingPrompt = manager.buildSessionContext().messages;
const trailingTokens = estimateTokens(messagesWithTrailingPrompt.at(-1));
assert.equal(calculatePiContextUsage(manager, 1000).tokens, 420 + trailingTokens);

// Aborted/error assistant usage is not authoritative, but the trailing message
// still participates in Pi's estimator until a successful provider usage lands.
appendAssistant(manager, 9999, "aborted");
const messagesWithAbort = manager.buildSessionContext().messages;
const expectedAfterAbort = 420
  + estimateTokens(messagesWithAbort.at(-2))
  + estimateTokens(messagesWithAbort.at(-1));
assert.equal(calculatePiContextUsage(manager, 1000).tokens, expectedAfterAbort);

const compacted = SessionManager.inMemory(process.cwd());
const firstEntryId = compacted.appendMessage({ role: "user", content: "compact me", timestamp: Date.now() });
appendAssistant(compacted, 600);
compacted.appendCompaction("summary after compaction", firstEntryId, 600);
assert.deepEqual(calculatePiContextUsage(compacted, 1000), {
  tokens: null,
  contextWindow: 1000,
  percent: null
});

compacted.appendMessage({ role: "user", content: "continue after compaction", timestamp: Date.now() });
appendAssistant(compacted, 250);
assert.deepEqual(calculatePiContextUsage(compacted, 1000), {
  tokens: 250,
  contextWindow: 1000,
  percent: 25
});

const empty = SessionManager.inMemory(process.cwd());
assert.deepEqual(calculatePiContextUsage(empty, 1_000_000), {
  tokens: 0,
  contextWindow: 1_000_000,
  percent: 0
});

console.log("Pi context usage parity checks passed.");
