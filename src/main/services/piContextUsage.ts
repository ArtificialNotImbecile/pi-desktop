import { existsSync } from "node:fs";
import path from "node:path";
import {
  SessionManager,
  calculateContextTokens,
  estimateTokens,
  getLatestCompactionEntry
} from "@earendil-works/pi-coding-agent";
import type { ThreadContextUsage, ThreadContextUsageRequest } from "../../shared/ipc.js";
import type { JasmineDatabase } from "../db/database.js";

type ContextMessage = ReturnType<SessionManager["buildSessionContext"]>["messages"][number];

export function getThreadPiContextUsage(
  db: JasmineDatabase,
  request: ThreadContextUsageRequest
): ThreadContextUsage {
  const thread = db.getThread(request.threadId);
  if (!thread) throw new Error("Thread does not exist.");

  const provider = request.providerId
    ? db.getProvider(request.providerId)
    : db.getRuntimeProvider();
  if (!provider) throw new Error("Provider does not exist.");
  const modelId = request.modelId?.trim() || provider.defaultModel;
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`${modelId} is not available for ${provider.name}.`);

  const contextWindow = model.contextWindow;
  const binding = db.getThreadSessionBinding(request.threadId);
  if (!binding) return usageResponse(thread.messageCount === 0 ? 0 : null, contextWindow);
  if (!existsSync(binding.sessionFile)) return usageResponse(null, contextWindow);

  try {
    const manager = SessionManager.open(binding.sessionFile, path.dirname(binding.sessionFile));
    if (manager.getSessionId() !== binding.sessionId) return usageResponse(null, contextWindow);
    return calculatePiContextUsage(manager, contextWindow);
  } catch {
    return usageResponse(null, contextWindow);
  }
}

/**
 * Mirrors Pi AgentSession.getContextUsage() using Pi's public SessionManager,
 * token estimator, usage calculator, and compaction primitives.
 */
export function calculatePiContextUsage(manager: SessionManager, contextWindow: number): ThreadContextUsage {
  if (contextWindow <= 0) throw new Error("Context window must be positive.");

  const branchEntries = manager.getBranch();
  const latestCompaction = getLatestCompactionEntry(branchEntries);
  if (latestCompaction) {
    const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
    const hasPostCompactionUsage = branchEntries
      .slice(compactionIndex + 1)
      .some((entry) => entry.type === "message" && validAssistantUsage(entry.message) > 0);
    if (!hasPostCompactionUsage) return usageResponse(null, contextWindow);
  }

  const messages = manager.buildSessionContext().messages;
  let usageTokens = 0;
  let lastUsageIndex: number | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const tokens = validAssistantUsage(messages[index]);
    if (tokens <= 0) continue;
    usageTokens = tokens;
    lastUsageIndex = index;
    break;
  }

  let tokens = usageTokens;
  const trailingStart = lastUsageIndex === null ? 0 : lastUsageIndex + 1;
  for (let index = trailingStart; index < messages.length; index += 1) {
    tokens += estimateTokens(messages[index]);
  }
  return usageResponse(tokens, contextWindow);
}

function validAssistantUsage(message: ContextMessage): number {
  if (message.role !== "assistant") return 0;
  if (message.stopReason === "aborted" || message.stopReason === "error") return 0;
  return calculateContextTokens(message.usage);
}

function usageResponse(tokens: number | null, contextWindow: number): ThreadContextUsage {
  return {
    tokens,
    contextWindow,
    percent: tokens === null ? null : (tokens / contextWindow) * 100
  };
}
