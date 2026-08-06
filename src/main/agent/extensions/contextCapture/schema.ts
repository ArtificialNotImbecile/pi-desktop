export const CONTEXT_TAXONOMY_SCHEMA_VERSION = 4 as const;

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
  policy: "single-capture" | "latest-capture";
};

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
  items: ContextTaxonomyItem[];
};
