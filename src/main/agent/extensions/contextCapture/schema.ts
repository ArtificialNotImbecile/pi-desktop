export const CONTEXT_TAXONOMY_SCHEMA_VERSION = 5 as const;

export type ContextTaxonomyKind =
  | "system_prompt"
  | "developer_instructions"
  | "project_context"
  | "skill_manifest"
  | "skill_instructions"
  | "prompt_template"
  | "memory"
  | "conversation_history"
  | "current_user_prompt"
  | "tool_definition"
  | "provider_options"
  | "attachment"
  | "provider_message"
  | "raw_payload"
  | "unknown";

export type ContextTaxonomySegment = {
  title: string;
  kind: ContextTaxonomyKind;
  confidence: number;
  tokenEstimate: number;
  text: string;
};

export type ContextTaxonomyPartKind =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "attachment"
  | "refusal"
  | "metadata";

export type ContextTaxonomyPart = {
  order: number;
  kind: ContextTaxonomyPartKind;
  title: string;
  text: string;
  format: "text" | "markdown" | "json";
  tokenEstimate: number;
  payloadPath?: string;
  toolName?: string;
  toolCallId?: string;
};

export type ContextTaxonomyItem = {
  order: number;
  role: string;
  source: string;
  label: string;
  kind?: ContextTaxonomyKind;
  confidence?: number;
  payloadPath?: string;
  tokenEstimate: number;
  preview: string;
  text?: string;
  segments?: ContextTaxonomySegment[];
  parts?: ContextTaxonomyPart[];
};

export type ContextPayloadShape = {
  topLevelOrder: string[];
  messageCount?: number;
  toolCount?: number;
  messagesBeforeTools?: boolean;
};

export type ContextCacheMetrics = {
  source: "assistant-usage";
  status: "hit" | "miss" | "unknown";
  inputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  hitRate: number;
  note: string;
};

export type ContextTaxonomySource = "provider-payload" | "jasmine-assembly";

export type ContextTaxonomyAssemblyReason =
  | "mock"
  | "no-capture"
  | "extension-missing";

export type ContextProviderRequestScope = {
  index: number;
  count: number;
  taskIndex?: number;
  policy: "single-capture" | "latest-capture" | "task-capture";
};

export type ContextReasoningPolicyId =
  | "deepseek-tool-interval-v1"
  | "kimi-k3-preserved-v1"
  | "kimi-k2.7-preserved-v1"
  | "kimi-k2.6-configurable-v1"
  | "kimi-k2.5-unsupported-v1"
  | "unknown";

export type ContextReasoningValidationBlock = {
  fingerprint: string;
  messageIndex: number;
  required: boolean;
  sent: boolean;
  reason: string;
};

export type ContextReasoningValidation = {
  status: "pass" | "fail" | "not_applicable" | "unknown";
  policyId: ContextReasoningPolicyId;
  policyVersion: 1;
  policySource?: string;
  summary: string;
  requiredCount: number;
  sentCount: number;
  blocks: ContextReasoningValidationBlock[];
};

export type ContextRawPayloadState = "complete" | "legacy_truncated" | "unavailable";

export type ContextTaxonomy = {
  capturedAt: string;
  provider: string;
  model: string;
  source: ContextTaxonomySource;
  assemblyReason?: ContextTaxonomyAssemblyReason;
  providerRequest?: ContextProviderRequestScope;
  rawPayload?: string;
  payloadHash?: string;
  payloadSchemaVersion?: number;
  payloadShape?: ContextPayloadShape;
  cacheMetrics?: ContextCacheMetrics;
  reasoningValidation?: ContextReasoningValidation;
  rawState?: ContextRawPayloadState;
  rawCharCount?: number;
  rawByteCount?: number;
  items: ContextTaxonomyItem[];
};
