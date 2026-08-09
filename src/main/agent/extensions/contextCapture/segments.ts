import type { ContextTaxonomyKind, ContextTaxonomySegment } from "./schema.js";

export function classifyTextSegments(text: string, fallbackKind: ContextTaxonomyKind, role = "unknown"): ContextTaxonomySegment[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (fallbackKind === "tool_definition") return [segment("Tool definition", "tool_definition", 0.98, trimmed)];
  if (fallbackKind === "provider_options") return splitProviderOptionSegments(trimmed) ?? [segment("Provider options", "provider_options", 0.96, trimmed)];
  if (fallbackKind === "raw_payload") return [segment("Raw payload", "raw_payload", 1, trimmed)];
  // Provider-owned taxonomy tags are instructions only in trusted instruction
  // roles. User/assistant text that happens to quote `<project_context>` or a
  // similar tag must remain conversation content.
  if (!isTrustedInstructionRole(role)) {
    return [classifyLooseSegment(trimmed, fallbackKind, role)];
  }

  const segments: ContextTaxonomySegment[] = [];
  const tagPattern = taxonomyTagPattern();
  let cursor = 0;
  for (const match of trimmed.matchAll(tagPattern)) {
    const index = match.index ?? 0;
    const before = trimmed.slice(cursor, index).trim();
    if (before) segments.push(classifyLooseSegment(before, fallbackKind, role));
    segments.push(classifyTaggedSegment(match[1], match[2].trim()));
    cursor = index + match[0].length;
  }

  const tail = trimmed.slice(cursor).trim();
  if (tail) segments.push(classifyLooseSegment(tail, fallbackKind, role));
  return segments.length > 0 ? segments : [classifyLooseSegment(trimmed, fallbackKind, role)];
}

export function estimateTokens(text: string): number {
  // Provider usage is the authoritative total. This estimate is only used to
  // show composition by part. CJK text is commonly close to one token per
  // character, while Latin/code prose is closer to four characters per token.
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.max(1, cjk + Math.ceil(other / 4));
}

export function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

export function fallbackKindForRole(role: string): ContextTaxonomyKind {
  if (role === "system") return "system_prompt";
  if (role === "developer") return "developer_instructions";
  if (role === "tool_definition") return "tool_definition";
  if (role === "request_options") return "provider_options";
  if (role === "user") return "current_user_prompt";
  return "conversation_history";
}

function splitProviderOptionSegments(text: string): ContextTaxonomySegment[] | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  const segments: ContextTaxonomySegment[] = [];
  const remaining = new Set(Object.keys(parsed));
  for (const key of OPTION_SEGMENT_ORDER) {
    if (!remaining.has(key)) continue;
    segments.push(segment(optionTitle(key), "provider_options", 0.96, optionJson(key, parsed[key])));
    remaining.delete(key);
  }
  if (remaining.size > 0) {
    const otherOptions: Record<string, unknown> = {};
    for (const key of Array.from(remaining).sort()) {
      otherOptions[key] = parsed[key];
    }
    segments.push(segment("Other provider options", "provider_options", 0.96, stringifyOptionValue(otherOptions)));
  }
  return segments.length > 0 ? segments : null;
}

const OPTION_SEGMENT_ORDER = [
  "model",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "response_format",
  "reasoning",
  "reasoning_effort",
  "tool_choice",
  "parallel_tool_calls",
  "store"
];

function optionTitle(key: string): string {
  const titles: Record<string, string> = {
    model: "Model",
    stream: "Stream",
    temperature: "Temperature",
    top_p: "Top-p",
    max_tokens: "Max tokens",
    max_completion_tokens: "Max completion tokens",
    max_output_tokens: "Max output tokens",
    response_format: "Response format",
    reasoning: "Reasoning",
    reasoning_effort: "Reasoning effort",
    tool_choice: "Tool choice",
    parallel_tool_calls: "Parallel tool calls",
    store: "Store"
  };
  return titles[key] ?? formatTagTitle(key.replace(/_/g, " "));
}

function optionJson(key: string, value: unknown): string {
  return stringifyOptionValue({ [key]: value });
}

function stringifyOptionValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function classifyTaggedSegment(tag: string, text: string): ContextTaxonomySegment {
  const normalized = tag.replace(/[-_:]+/g, " ").trim().toLowerCase();
  const kind = tagKind(normalized) ?? "unknown";
  return segment(titleForKind(kind, formatTagTitle(normalized)), kind, 0.98, text);
}

function classifyLooseSegment(text: string, fallbackKind: ContextTaxonomyKind, role: string): ContextTaxonomySegment {
  const patternKind = isTrustedInstructionRole(role) ? patternKindForText(text) : null;
  if (patternKind) return segment(titleForKind(patternKind), patternKind, 0.72, text);
  const kind = fallbackKind === "provider_message" && role === "system" ? "system_prompt" : fallbackKind;
  return segment(titleForKind(kind), kind, defaultConfidence(kind), text);
}

function isTrustedInstructionRole(role: string): boolean {
  const normalized = role.toLowerCase();
  return normalized === "system" || normalized === "developer";
}

function patternKindForText(text: string): ContextTaxonomyKind | null {
  if (/(^|\n)\s*(#\s*)?AGENTS\.md\b|Agent Instructions|Current working directory:|project context/i.test(text)) return "project_context";
  if (/SKILL\.md|skill instructions|Available skills|selected skill/i.test(text)) return "skill_instructions";
  if (/prompt template|slash command|argument-hint/i.test(text)) return "prompt_template";
  if (/developer instructions/i.test(text)) return "developer_instructions";
  if (/(^|\n)\s*(Remembered context|Memory context|Memories:|Memory:)/i.test(text)) return "memory";
  return null;
}

function taxonomyTagPattern(): RegExp {
  return new RegExp(`<(${TAXONOMY_TAG_NAMES.map(escapeRegExp).join("|")})>([\\s\\S]*?)<\\/\\1>`, "gi");
}

const TAXONOMY_TAG_NAMES = [
  "project_context",
  "project-context",
  "workspace_context",
  "workspace-context",
  "developer_instructions",
  "developer-instructions",
  "skill_instructions",
  "skill-instructions",
  "skill_manifest",
  "skill-manifest",
  "skill_manifests",
  "skill-manifests",
  "available_skills",
  "available-skills",
  "prompt_template",
  "prompt-template",
  "prompt_templates",
  "prompt-templates",
  "memory_context",
  "memory-context",
  "remembered_context",
  "remembered-context",
  "system_prompt",
  "system-prompt",
  "user_message",
  "user-message",
  "explicit_user_selected_skills",
  "explicit-user-selected-skills",
  "attachment",
  "attachments",
  "attached_files",
  "attached-files",
  "attached_local_paths",
  "attached-local-paths"
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagKind(tag: string): ContextTaxonomyKind | null {
  if (tag === "project context" || tag === "workspace context") return "project_context";
  if (tag === "developer instructions") return "developer_instructions";
  if (tag === "skill instructions") return "skill_instructions";
  if (tag === "skill manifests" || tag === "skill manifest") return "skill_manifest";
  if (tag === "available skills") return "skill_manifest";
  if (tag === "prompt template" || tag === "prompt templates") return "prompt_template";
  if (tag === "memory context" || tag === "remembered context") return "memory";
  if (tag === "system prompt") return "system_prompt";
  if (tag === "user message") return "current_user_prompt";
  if (tag === "explicit user selected skills") return "skill_instructions";
  if (tag === "attachment" || tag === "attachments" || tag === "attached files" || tag === "attached local paths") return "attachment";
  return null;
}

function titleForKind(kind: ContextTaxonomyKind, fallback?: string): string {
  const titles: Record<ContextTaxonomyKind, string> = {
    system_prompt: "System prompt",
    developer_instructions: "Developer instructions",
    project_context: "Project context",
    skill_manifest: "Skill manifest",
    skill_instructions: "Skill instructions",
    prompt_template: "Prompt template",
    memory: "Memory",
    conversation_history: "Conversation history",
    current_user_prompt: "Current user prompt",
    tool_definition: "Tool definition",
    provider_options: "Provider options",
    attachment: "Attachment",
    provider_message: "Provider message",
    raw_payload: "Raw payload",
    unclassified: "Unclassified payload",
    unknown: fallback || "Context text"
  };
  return titles[kind];
}

function formatTagTitle(tag: string): string {
  if (!tag) return "Context text";
  return tag.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function defaultConfidence(kind: ContextTaxonomyKind): number {
  if (kind === "system_prompt" || kind === "current_user_prompt") return 0.9;
  if (kind === "conversation_history") return 0.78;
  if (kind === "unknown") return 0.45;
  return 0.82;
}

function segment(title: string, kind: ContextTaxonomyKind, confidence: number, text: string): ContextTaxonomySegment {
  return {
    title,
    kind,
    confidence,
    tokenEstimate: estimateTokens(text),
    text
  };
}
