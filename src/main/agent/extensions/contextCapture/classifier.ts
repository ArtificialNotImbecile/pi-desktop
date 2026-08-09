import { createHash } from "node:crypto";
import { CONTEXT_TAXONOMY_SCHEMA_VERSION } from "./schema.js";
import { classifyTextSegments, estimateTokens, fallbackKindForRole, previewText } from "./segments.js";
import type { ContextCacheMetrics, ContextPayloadShape, ContextTaxonomy, ContextTaxonomyItem, ContextTaxonomyKind, ContextTaxonomyPart } from "./schema.js";

export { classifyTextSegments, estimateTokens, previewText } from "./segments.js";

export type ContextCaptureMetadata = {
  provider: string;
  model: string;
  capturedAt?: string;
  source?: ContextTaxonomy["source"];
  currentUserPromptText?: string;
};

type PayloadMessage = {
  index: number;
  role?: unknown;
  text: string;
  payloadPath: string;
  parts: ContextTaxonomyPart[];
  syntheticToolResult: boolean;
};

type PayloadTool = {
  index: number;
  name?: string;
  text: string;
  payloadPath: string;
};

export type ContextCacheUsage = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  totalTokens?: unknown;
};

export function providerPayloadToContextTaxonomy(payload: unknown, metadata: ContextCaptureMetadata): ContextTaxonomy {
  const sanitizedPayload = sanitizePayload(payload);
  const rawPayload = safeStringify(sanitizedPayload);
  const messages = extractPayloadMessages(sanitizedPayload);
  const tools = extractPayloadTools(sanitizedPayload);
  const options = extractPayloadOptions(sanitizedPayload);
  const currentUserMessageIndex = findCurrentUserMessageIndex(messages, metadata.currentUserPromptText);
  const payloadShape = describePayloadShape(sanitizedPayload);
  let order = 1;
  const items: ContextTaxonomyItem[] = [];

  for (const section of orderedPayloadSections(payloadShape, messages.length > 0, tools.length > 0)) {
    if (section === "messages") {
      for (const message of messages) {
        const role = String(message.role ?? "unknown");
        const { kind, confidence } = classifyMessage(message, currentUserMessageIndex);
        items.push(taxonomyItem({
          order: order++,
          role,
          source: "provider.payload.messages",
          label: providerMessageLabel(message, kind),
          kind,
          confidence,
          payloadPath: message.payloadPath,
          text: message.text,
          parts: message.parts
        }));
      }
      continue;
    }
    for (const tool of tools) {
      items.push(taxonomyItem({
        order: order++,
        role: "tool_definition",
        source: "provider.payload.tools",
        label: tool.name ? `Tool definition: ${tool.name}` : `Tool definition ${tool.index + 1}`,
        kind: "tool_definition",
        confidence: 0.98,
        payloadPath: tool.payloadPath,
        text: tool.text
      }));
    }
  }

  if (options) {
    items.push(taxonomyItem({
      order: order++,
      role: "request_options",
      source: "provider.payload.options",
      label: "Provider request options",
      kind: "provider_options",
      confidence: 0.96,
      payloadPath: options.payloadPath,
      text: options.text
    }));
  }

  if (items.length === 0) {
    items.push(taxonomyItem({
      order: 1,
      role: "payload",
      source: "provider.payload",
      label: "Provider request payload",
      kind: "raw_payload",
      confidence: 1,
      payloadPath: "$",
      text: rawPayload
    }));
  }

  return {
    capturedAt: metadata.capturedAt ?? new Date().toISOString(),
    provider: metadata.provider,
    model: metadata.model,
    source: metadata.source ?? "provider-payload",
    rawPayload,
    payloadHash: createHash("sha256").update(rawPayload).digest("hex"),
    rawState: "complete",
    rawCharCount: rawPayload.length,
    rawByteCount: Buffer.byteLength(rawPayload, "utf8"),
    payloadSchemaVersion: CONTEXT_TAXONOMY_SCHEMA_VERSION,
    payloadShape,
    items
  };
}

export function withContextCacheMetrics(taxonomy: ContextTaxonomy, usage: ContextCacheUsage | undefined): ContextTaxonomy {
  const metrics = contextCacheMetricsFromUsage(usage);
  return metrics ? { ...taxonomy, cacheMetrics: metrics } : taxonomy;
}

// Persisted-size guard for the Context taxonomy. The taxonomy is a debug/inspection
// surface stored inline in each assistant message's timeline_json. Without a bound,
// vision payloads (inline base64 images) and long conversations make a single message
// tens of MB, which bloats SQLite and makes those threads extremely slow to load over
// IPC. This collapses base64 media and caps the largest text fields while keeping the
// structure the Context taxonomy panel renders.
const TAXONOMY_MAX_RAW_PAYLOAD_CHARS = 200_000;
const TAXONOMY_MAX_ITEM_TEXT_CHARS = 20_000;
const TAXONOMY_MAX_SEGMENT_TEXT_CHARS = 20_000;

export function capContextTaxonomyForStorage(taxonomy: ContextTaxonomy): ContextTaxonomy {
  const items = taxonomy.items.map((item) => {
    const text = item.text === undefined ? undefined : capText(collapseInlineMedia(item.text), TAXONOMY_MAX_ITEM_TEXT_CHARS);
    const segments = item.segments?.map((segment) => {
      const segmentText = capText(collapseInlineMedia(segment.text), TAXONOMY_MAX_SEGMENT_TEXT_CHARS);
      return segmentText === segment.text ? segment : { ...segment, text: segmentText };
    });
    if (text === item.text && segments === item.segments) return item;
    return { ...item, ...(text === undefined ? {} : { text }), ...(segments ? { segments } : {}) };
  });
  const rawPayload = taxonomy.rawPayload === undefined
    ? undefined
    : capText(collapseInlineMedia(taxonomy.rawPayload), TAXONOMY_MAX_RAW_PAYLOAD_CHARS);
  const rawWasTruncated = rawPayload !== taxonomy.rawPayload;
  return {
    ...taxonomy,
    ...(rawPayload === undefined ? {} : { rawPayload }),
    ...(rawPayload === undefined ? {} : {
      payloadHash: createHash("sha256").update(rawPayload).digest("hex"),
      rawState: rawWasTruncated ? "legacy_truncated" : (taxonomy.rawState ?? "complete"),
      rawCharCount: rawPayload.length,
      rawByteCount: Buffer.byteLength(rawPayload, "utf8")
    }),
    items
  };
}

function collapseInlineMedia(text: string): string {
  return text.replace(
    /data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g,
    (_match, mediaType: string, data: string) => `data:${mediaType};base64,[omitted ${data.length} chars]`
  );
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... truncated ${text.length - max} chars for storage ...]`;
}

export function contextCacheMetricsFromUsage(usage: ContextCacheUsage | undefined): ContextCacheMetrics | null {
  if (!usage) return null;
  const cacheHitTokens = nonNegativeNumber(usage.cacheRead);
  const cacheWriteTokens = nonNegativeNumber(usage.cacheWrite);
  const cacheMissTokens = nonNegativeNumber(usage.input);
  const outputTokens = nonNegativeNumber(usage.output);
  const inputTokens = cacheHitTokens + cacheMissTokens + cacheWriteTokens;
  const totalTokens = nonNegativeNumber(usage.totalTokens) || inputTokens + outputTokens;
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return null;
  const hitRate = inputTokens > 0 ? cacheHitTokens / inputTokens : 0;
  return {
    source: "assistant-usage",
    status: cacheHitTokens > 0 ? "hit" : inputTokens > 0 ? "miss" : "unknown",
    inputTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens,
    hitRate,
    note: "Provider usage parsed by Pi. For DeepSeek, cacheRead maps to prompt_cache_hit_tokens and input maps to prompt_cache_miss_tokens."
  };
}

export function taxonomyItem(input: {
  order: number;
  role: string;
  source: string;
  label: string;
  kind: ContextTaxonomyKind;
  confidence: number;
  payloadPath?: string;
  text: string;
  parts?: ContextTaxonomyPart[];
}): ContextTaxonomyItem {
  return {
    order: input.order,
    role: input.role,
    source: input.source,
    label: input.label,
    kind: input.kind,
    confidence: input.confidence,
    payloadPath: input.payloadPath,
    tokenEstimate: estimateTokens(input.text),
    preview: previewText(input.text),
    text: input.text,
    segments: classifyTextSegments(input.text, input.kind, input.role),
    ...(input.parts?.length ? { parts: input.parts } : {})
  };
}

export function withMissingContextTaxonomySegments(taxonomy: ContextTaxonomy): ContextTaxonomy {
  let changed = false;
  const items = taxonomy.items.map((item) => {
    if (item.segments?.length) return item;
    const text = item.text ?? item.preview;
    if (!text.trim()) return item;
    changed = true;
    return {
      ...item,
      segments: classifyTextSegments(text, item.kind ?? fallbackKindForRole(item.role), item.role)
    };
  });
  return changed ? { ...taxonomy, items } : taxonomy;
}

function orderedPayloadSections(shape: ContextPayloadShape | undefined, hasMessages: boolean, hasTools: boolean): Array<"messages" | "tools"> {
  const sections: Array<"messages" | "tools"> = [];
  const add = (section: "messages" | "tools", exists: boolean) => {
    if (exists && !sections.includes(section)) sections.push(section);
  };
  for (const key of shape?.topLevelOrder ?? []) {
    if (key === "messages" || key === "input") add("messages", hasMessages);
    if (key === "tools" || key === "toolDefinitions") add("tools", hasTools);
  }
  add("messages", hasMessages);
  add("tools", hasTools);
  return sections;
}

function describePayloadShape(payload: unknown): ContextPayloadShape | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const topLevelOrder = Object.keys(record);
  const messageCount = Array.isArray(record.messages) ? record.messages.length : undefined;
  const toolCount = Array.isArray(record.tools) ? record.tools.length : undefined;
  const messageKey = Array.isArray(record.messages) ? "messages" : Array.isArray(record.input) ? "input" : null;
  const toolKey = Array.isArray(record.tools) ? "tools" : Array.isArray(record.toolDefinitions) ? "toolDefinitions" : null;
  const messagesIndex = messageKey ? topLevelOrder.indexOf(messageKey) : -1;
  const toolsIndex = toolKey ? topLevelOrder.indexOf(toolKey) : -1;
  return {
    topLevelOrder,
    ...(messageCount !== undefined ? { messageCount } : Array.isArray(record.input) ? { messageCount: record.input.length } : {}),
    ...(toolCount !== undefined ? { toolCount } : Array.isArray(record.toolDefinitions) ? { toolCount: record.toolDefinitions.length } : {}),
    ...(messagesIndex >= 0 && toolsIndex >= 0 ? { messagesBeforeTools: messagesIndex < toolsIndex } : {})
  };
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function sanitizePayload(value: unknown): unknown {
  return sanitizeValue(value, "", new WeakSet<object>());
}

function sanitizeValue(value: unknown, key: string, seen: WeakSet<object>): unknown {
  if (isSecretKey(key)) return "[redacted]";
  if (typeof value === "string") {
    if (/^(?:data|inlineData)$/i.test(key) && isLikelyBase64(value)) return `[redacted base64 ${value.length} chars]`;
    return redactSecrets(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, "", seen));
    const output: Record<string, unknown> = {};
    for (const [innerKey, innerValue] of Object.entries(value)) {
      output[innerKey] = sanitizeValue(innerValue, innerKey, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function isSecretKey(key: string): boolean {
  // Token *values* are sensitive; token-count fields such as max_tokens are
  // model settings/usage and must remain inspectable in the payload taxonomy.
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (normalized === "token_count" || /^(?:max|prompt|completion|input|output|total|cache|cached|reasoning|budget)_tokens?(?:_count)?$/.test(normalized)) return false;
  return /api[_-]?key|authorization|bearer|(^|[_-])token($|[_-])|auth[_-]?token|access[_-]?token|id[_-]?token|session[_-]?token|private[_-]?key|client[_-]?secret|secret|password|credential/i.test(normalized);
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|x-amz-signature)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/\bdata:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g, (_match, mediaType: string, data: string) => {
      return `data:${mediaType};base64,[redacted ${data.length} chars]`;
    });
}

function isLikelyBase64(value: string): boolean {
  return value.length >= 64 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function extractPayloadMessages(payload: unknown): PayloadMessage[] {
  const candidate = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const key = Array.isArray(candidate.messages) ? "messages" : Array.isArray(candidate.input) ? "input" : null;
  const direct = key ? candidate[key] as unknown[] : [];
  return direct.map((item, index) => {
    const message = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const payloadPath = `$.${key ?? "messages"}[${index}]`;
    const parts = messageParts(message, payloadPath);
    return {
      index,
      role: message.role,
      text: parts.map((part) => part.text).filter(Boolean).join("\n\n") || messageText(item),
      payloadPath,
      parts,
      syntheticToolResult: isStructuredToolResultAttachment(message)
    };
  });
}

function extractPayloadTools(payload: unknown): PayloadTool[] {
  const candidate = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const key = Array.isArray(candidate.tools) ? "tools" : Array.isArray(candidate.toolDefinitions) ? "toolDefinitions" : null;
  const direct = key ? candidate[key] as unknown[] : [];
  return direct.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : {};
    const name = typeof fn.name === "string"
      ? fn.name
      : typeof record.name === "string"
        ? record.name
        : undefined;
    return {
      index,
      name,
      text: safeStringify(item),
      payloadPath: `$.${key ?? "tools"}[${index}]`
    };
  });
}

function extractPayloadOptions(payload: unknown): { text: string; payloadPath: string } | null {
  const candidate = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (!candidate) return null;
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (key === "messages" || key === "input" || key === "tools" || key === "toolDefinitions") continue;
    options[key] = value;
  }
  return Object.keys(options).length > 0 ? { text: safeStringify(options), payloadPath: "$.{provider-options}" } : null;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => messageText(item)).filter(Boolean).join("\n");
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (typeof record.type === "string") return `[${record.type}] ${safeStringify(record)}`;
  }
  return safeStringify(content);
}

function messageParts(message: Record<string, unknown>, payloadPath: string): ContextTaxonomyPart[] {
  const role = String(message.role ?? "unknown").toLowerCase();
  const parts: ContextTaxonomyPart[] = [];
  const push = (input: Omit<ContextTaxonomyPart, "order" | "tokenEstimate">) => {
    parts.push({ ...input, order: parts.length + 1, tokenEstimate: estimateTokens(input.text) });
  };

  const reasoning = typeof message.reasoning_content === "string"
    ? message.reasoning_content
    : typeof message.reasoning === "string"
      ? message.reasoning
      : "";
  if (reasoning) {
    push({ kind: "reasoning", title: "Reasoning", text: reasoning, format: "markdown", payloadPath: `${payloadPath}.reasoning_content` });
  }

  if (role === "tool") {
    const text = messageText(message.content ?? message.text ?? "");
    push({
      kind: "tool_result",
      title: "Tool result",
      text,
      format: looksLikeJsonText(text) ? "json" : "text",
      payloadPath: `${payloadPath}.content`,
      ...(typeof message.name === "string" ? { toolName: message.name } : {}),
      ...(typeof message.tool_call_id === "string" ? { toolCallId: message.tool_call_id } : {})
    });
  } else {
    appendContentParts(message.content ?? message.text, `${payloadPath}.content`, push);
  }

  if (typeof message.refusal === "string" && message.refusal) {
    push({ kind: "refusal", title: "Refusal", text: message.refusal, format: "markdown", payloadPath: `${payloadPath}.refusal` });
  }

  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((call, index) => {
      const record = call && typeof call === "object" ? call as Record<string, unknown> : {};
      const fn = record.function && typeof record.function === "object" ? record.function as Record<string, unknown> : {};
      push({
        kind: "tool_call",
        title: typeof fn.name === "string" ? `Tool call: ${fn.name}` : "Tool call",
        text: safeStringify(call),
        format: "json",
        payloadPath: `${payloadPath}.tool_calls[${index}]`,
        ...(typeof fn.name === "string" ? { toolName: fn.name } : {}),
        ...(typeof record.id === "string" ? { toolCallId: record.id } : {})
      });
    });
  }

  if (parts.length === 0) {
    push({ kind: "metadata", title: "Message metadata", text: safeStringify(message), format: "json", payloadPath });
  }
  return parts;
}

function appendContentParts(
  content: unknown,
  payloadPath: string,
  push: (input: Omit<ContextTaxonomyPart, "order" | "tokenEstimate">) => void
): void {
  if (typeof content === "string") {
    if (content) push({ kind: "text", title: "Text", text: content, format: "markdown", payloadPath });
    return;
  }
  if (!Array.isArray(content)) {
    if (content !== undefined && content !== null) push({ kind: "metadata", title: "Content", text: safeStringify(content), format: "json", payloadPath });
    return;
  }
  content.forEach((entry, index) => {
    const path = `${payloadPath}[${index}]`;
    if (typeof entry === "string") {
      if (entry) push({ kind: "text", title: "Text", text: entry, format: "markdown", payloadPath: path });
      return;
    }
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const type = String(record.type ?? "").toLowerCase();
    const reasoning = typeof record.thinking === "string" ? record.thinking : typeof record.reasoning === "string" ? record.reasoning : "";
    if ((type === "thinking" || type.includes("reason")) && reasoning) {
      push({ kind: "reasoning", title: "Reasoning", text: reasoning, format: "markdown", payloadPath: path });
      return;
    }
    if (type === "tool_use" || type === "toolcall" || type === "tool_call") {
      push({
        kind: "tool_call",
        title: typeof record.name === "string" ? `Tool call: ${record.name}` : "Tool call",
        text: safeStringify(record),
        format: "json",
        payloadPath: path,
        ...(typeof record.name === "string" ? { toolName: record.name } : {}),
        ...(typeof record.id === "string" ? { toolCallId: record.id } : {})
      });
      return;
    }
    if (type === "tool_result" || type === "toolresult") {
      push({
        kind: "tool_result",
        title: "Tool result",
        text: safeStringify(record),
        format: "json",
        payloadPath: path,
        ...(typeof record.tool_use_id === "string" ? { toolCallId: record.tool_use_id } : {})
      });
      return;
    }
    if (typeof record.text === "string") {
      push({ kind: type.includes("reason") || type === "thinking" ? "reasoning" : "text", title: type === "thinking" ? "Reasoning" : "Text", text: record.text, format: "markdown", payloadPath: `${path}.text` });
      return;
    }
    if (isAttachmentBlock(record)) {
      push({ kind: "attachment", title: "Attachment", text: safeStringify(record), format: "json", payloadPath: path });
      return;
    }
    push({ kind: "metadata", title: type ? `Content: ${type}` : "Content", text: safeStringify(record), format: "json", payloadPath: path });
  });
}

function isAttachmentBlock(record: Record<string, unknown>): boolean {
  const type = String(record.type ?? "").toLowerCase();
  return type.includes("image") || type.includes("audio") || type.includes("file") || "image_url" in record || "source" in record || "inlineData" in record;
}

function looksLikeJsonText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return false;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}

function isStructuredToolResultAttachment(message: Record<string, unknown>): boolean {
  if (String(message.role ?? "").toLowerCase() !== "user" || !Array.isArray(message.content)) return false;
  const hasAdapterMarker = message.content.some((entry) => typeof entry === "string" && /^Attached image\(s\) from tool result:/i.test(entry.trim()));
  const hasAttachment = message.content.some((entry) => entry && typeof entry === "object" && isAttachmentBlock(entry as Record<string, unknown>));
  return hasAdapterMarker && hasAttachment;
}

function findCurrentUserMessageIndex(messages: PayloadMessage[], currentUserPromptText?: string): number {
  const normalizedPrompt = normalizePromptText(currentUserPromptText);
  if (normalizedPrompt) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!isRole(message, "user") || isSyntheticToolResultUserMessage(message)) continue;
      if (messageMatchesCurrentPrompt(message.text, normalizedPrompt)) return message.index;
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRole(message, "user") && !isSyntheticToolResultUserMessage(message)) return message.index;
  }
  return -1;
}

function normalizePromptText(value: string | undefined): string {
  return stripAttachmentSummary(value?.replace(/\r\n/g, "\n").trim() ?? "");
}

function stripAttachmentSummary(value: string): string {
  return value.replace(/\n\n(?:Attached local paths|Attachments):\n[\s\S]*$/i, "").trim();
}

function messageMatchesCurrentPrompt(messageText: string, normalizedPrompt: string): boolean {
  const normalizedMessage = normalizePromptText(messageText);
  return normalizedMessage === normalizedPrompt
    || normalizedMessage.startsWith(`${normalizedPrompt}\n`)
    || normalizedMessage.includes(`<user_message>\n${normalizedPrompt}\n</user_message>`);
}

function isRole(message: PayloadMessage, role: string): boolean {
  return String(message.role ?? "").toLowerCase() === role;
}

function isSyntheticToolResultUserMessage(message: PayloadMessage): boolean {
  return isRole(message, "user") && message.syntheticToolResult;
}

function classifyMessage(message: PayloadMessage, currentUserMessageIndex: number): { kind: ContextTaxonomyKind; confidence: number } {
  const normalized = String(message.role ?? "unknown").toLowerCase();
  if (normalized === "system") return { kind: "system_prompt", confidence: 0.95 };
  if (normalized === "developer") return { kind: "developer_instructions", confidence: 0.94 };
  if (isSyntheticToolResultUserMessage(message)) return { kind: "attachment", confidence: 0.82 };
  if (normalized === "user" && message.index === currentUserMessageIndex) return { kind: "current_user_prompt", confidence: 0.95 };
  if (normalized === "user" || normalized === "assistant" || normalized === "tool") return { kind: "conversation_history", confidence: 0.78 };
  return { kind: "provider_message", confidence: 0.55 };
}

function providerMessageLabel(message: PayloadMessage, kind: ContextTaxonomyKind): string {
  if (kind === "current_user_prompt") return "Current user prompt";
  if (kind === "attachment" && isSyntheticToolResultUserMessage(message)) return "Tool result attachment";
  return `Provider message ${message.index + 1}`;
}
