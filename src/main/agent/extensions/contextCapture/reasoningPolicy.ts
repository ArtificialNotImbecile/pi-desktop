import { createHash } from "node:crypto";
import type { ContextReasoningPolicyId, ContextReasoningValidation, ContextReasoningValidationBlock } from "./schema.js";

const DEEPSEEK_POLICY_URL = "https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/";
const KIMI_POLICY_URL = "https://platform.kimi.com/docs/guide/use-thinking-models";

type CanonicalMessageInfo = {
  index: number;
  role: string;
  reasoning: string[];
  hasToolCall: boolean;
  provider?: string;
  model?: string;
};

export function validateReasoningRetention(input: {
  payload: unknown;
  canonicalMessages?: unknown[];
  provider: string;
  model: string;
}): ContextReasoningValidation {
  const policyId = reasoningPolicyId(input.provider, input.model);
  const policySource = policyId.startsWith("deepseek") ? DEEPSEEK_POLICY_URL : policyId.startsWith("kimi") ? KIMI_POLICY_URL : undefined;
  if (policyId === "unknown") return validation("unknown", policyId, "No verified reasoning-retention policy is registered for this provider/model.", [], policySource);
  if (policyId === "kimi-k2.5-unsupported-v1") return validation("not_applicable", policyId, "Kimi K2.5 does not support preserved thinking.", [], policySource);
  if (!Array.isArray(input.canonicalMessages)) {
    return validation("unknown", policyId, "Canonical active-session context was unavailable, so retention cannot be verified safely.", [], policySource);
  }

  const canonical = input.canonicalMessages.map((message, index) => canonicalMessageInfo(message, index));
  const currentProvider = input.provider.toLowerCase();
  const currentModel = input.model.toLowerCase();
  const foreignReasoning = canonical.some((message) => message.reasoning.length > 0 && (
    (message.provider && message.provider.toLowerCase() !== currentProvider)
    || (message.model && message.model.toLowerCase() !== currentModel)
  ));
  if (foreignReasoning) {
    return validation("unknown", policyId, "Historical reasoning was produced by a different provider/model, so signature compatibility cannot be verified safely.", [], policySource);
  }
  const sentCounts = multiset(sentReasoningTexts(input.payload).map(fingerprint));
  const lastUserIndex = canonical.map((message) => message.role).lastIndexOf("user");
  const keepAll = kimiKeepAll(input.payload);
  const blocks: ContextReasoningValidationBlock[] = [];

  for (const message of canonical) {
    for (const reasoning of message.reasoning) {
      const interval = userInterval(canonical, message.index);
      const inCurrentInterval = interval.userIndex === lastUserIndex;
      let required = false;
      let reason = "The selected provider policy does not require this reasoning block in this request.";

      if (policyId === "deepseek-tool-interval-v1" && interval.hasToolCall) {
        required = true;
        reason = "DeepSeek requires every reasoning block in a user-to-user interval that contains a tool call, including post-tool final reasoning.";
      } else if (policyId === "kimi-k3-preserved-v1" || policyId === "kimi-k2.7-preserved-v1") {
        required = true;
        reason = "This Kimi model always preserves reasoning across tool calls and user turns.";
      } else if (policyId === "kimi-k2.6-configurable-v1" && ((inCurrentInterval && interval.hasToolCall) || keepAll)) {
        required = true;
        reason = keepAll
          ? "Kimi K2.6 thinking.keep=all requires cross-turn reasoning retention."
          : "Kimi K2.6 requires reasoning retention inside the active tool loop.";
      }

      const hash = fingerprint(reasoning);
      const available = sentCounts.get(hash) ?? 0;
      const sent = available > 0;
      if (sent && required) sentCounts.set(hash, available - 1);
      blocks.push({ fingerprint: hash, messageIndex: message.index, required, sent, reason });
    }
  }

  const required = blocks.filter((block) => block.required);
  if (required.length === 0) {
    return validation("not_applicable", policyId, "No reasoning block is required by this policy for the captured request.", blocks, policySource);
  }
  const missing = required.filter((block) => !block.sent);
  return validation(
    missing.length === 0 ? "pass" : "fail",
    policyId,
    missing.length === 0
      ? `All ${required.length} required reasoning block${required.length === 1 ? " was" : "s were"} present in the provider payload.`
      : `${missing.length} of ${required.length} required reasoning block${required.length === 1 ? " is" : "s are"} missing from the provider payload.`,
    blocks,
    policySource
  );
}

export function reasoningPolicyId(provider: string, model: string): ContextReasoningPolicyId {
  const value = `${provider} ${model}`.toLowerCase();
  if (value.includes("deepseek")) return "deepseek-tool-interval-v1";
  if (/kimi[-_ ]?k?3\b/.test(value)) return "kimi-k3-preserved-v1";
  if (/kimi[-_ ]?k?2[._-]?7/.test(value)) return "kimi-k2.7-preserved-v1";
  if (/kimi[-_ ]?k?2[._-]?6/.test(value)) return "kimi-k2.6-configurable-v1";
  if (/kimi[-_ ]?k?2[._-]?5/.test(value)) return "kimi-k2.5-unsupported-v1";
  return "unknown";
}

function validation(
  status: ContextReasoningValidation["status"],
  policyId: ContextReasoningPolicyId,
  summary: string,
  blocks: ContextReasoningValidationBlock[],
  policySource?: string
): ContextReasoningValidation {
  const required = blocks.filter((block) => block.required);
  return {
    status,
    policyId,
    policyVersion: 1,
    ...(policySource ? { policySource } : {}),
    summary,
    requiredCount: required.length,
    sentCount: required.filter((block) => block.sent).length,
    blocks
  };
}

function canonicalMessageInfo(value: unknown, index: number): CanonicalMessageInfo {
  const message = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const role = String(message.role ?? "unknown").toLowerCase();
  const reasoning: string[] = [];
  let hasToolCall = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) reasoning.push(message.reasoning_content);
  if (typeof message.reasoning === "string" && message.reasoning.trim()) reasoning.push(message.reasoning);
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      const type = String(record.type ?? "").toLowerCase();
      const text = typeof record.thinking === "string" ? record.thinking : typeof record.reasoning === "string" ? record.reasoning : "";
      if ((type === "thinking" || type.includes("reason")) && text.trim()) reasoning.push(text);
      if (type === "toolcall" || type === "tool_call" || type === "tooluse" || type === "tool_use") hasToolCall = true;
    }
  }
  return {
    index,
    role: role === "toolresult" ? "tool" : role,
    reasoning,
    hasToolCall,
    ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
    ...(typeof message.model === "string" ? { model: message.model } : typeof message.modelId === "string" ? { model: message.modelId } : {})
  };
}

function userInterval(messages: CanonicalMessageInfo[], messageIndex: number): { userIndex: number; hasToolCall: boolean } {
  let userIndex = -1;
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") { userIndex = index; break; }
  }
  let end = messages.length;
  for (let index = messageIndex + 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") { end = index; break; }
  }
  return {
    userIndex,
    hasToolCall: messages.slice(userIndex + 1, end).some((message) => message.hasToolCall)
  };
}

function sentReasoningTexts(payload: unknown): string[] {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const messages = Array.isArray(record.messages) ? record.messages : Array.isArray(record.input) ? record.input : [];
  const result: string[] = [];
  for (const value of messages) {
    const message = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) result.push(message.reasoning_content);
    if (typeof message.reasoning === "string" && message.reasoning.trim()) result.push(message.reasoning);
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const part = block as Record<string, unknown>;
      const type = String(part.type ?? "").toLowerCase();
      const text = typeof part.thinking === "string" ? part.thinking : typeof part.reasoning === "string" ? part.reasoning : "";
      if ((type === "thinking" || type.includes("reason")) && text.trim()) result.push(text);
    }
  }
  return result;
}

function multiset(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 16);
}

function kimiKeepAll(payload: unknown): boolean {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const thinking = record.thinking && typeof record.thinking === "object" ? record.thinking as Record<string, unknown> : null;
  return String(thinking?.keep ?? "").toLowerCase() === "all";
}
