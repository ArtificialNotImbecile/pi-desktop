import type {
  PermissionApprovalPrompt,
  PermissionApprovalResponse,
  PermissionMode
} from "./permissions.js";

export type {
  PermissionApprovalDecision,
  PermissionApprovalPrompt,
  PermissionApprovalReason,
  PermissionApprovalResponse,
  PermissionMode,
  PermissionToolName
} from "./permissions.js";

export type ChatRole = "user" | "assistant";
export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AppLanguage = "en" | "zh";

export type ChatTimelineItem =
  | {
      id: string;
      kind: "thinking";
      text: string;
    }
  | {
      id: string;
      kind: "tool_call";
      /** Provider/session correlation id; `id` remains the stable renderer key. */
      toolCallId?: string;
      toolName: string;
      title: string;
      argumentsJson: string;
    }
  | {
      id: string;
      kind: "tool_result";
      /** Provider/session correlation id; `id` remains the stable renderer key. */
      toolCallId?: string;
      toolName: string;
      title: string;
      content: string;
      isError?: boolean;
    }
  | {
      id: string;
      kind: "assistant_text";
      text: string;
    }
  | {
      id: string;
      kind: "system";
      title: string;
      text: string;
      customType?: string;
      origin?: "pi-extension";
      data?: unknown;
    };

export type ChatMessage = {
  id: string;
  // Renderer-only identity used to keep a live message's DOM node mounted when
  // the same message is replaced by its database-backed representation. It is
  // intentionally not persisted; ordinary message lists fall back to `id`.
  renderId?: string;
  threadId: string;
  runId?: string;
  role: ChatRole;
  content: string;
  attachments?: PickedPath[];
  createdAt: string;
  elapsedMs?: number;
  modelId?: string;
  status?: "sent" | "error";
  memoryUsed?: MemoryReference[];
  skillsUsed?: SkillReference[];
  pluginsUsed?: PluginReference[];
  webSearchUsed?: WebSearchResult[];
  timeline?: ChatTimelineItem[];
};

export type ChatStreamEvent = {
  requestId: string;
  threadId: string;
  status: "running" | "done" | "aborted" | "error";
  content?: string;
  timeline?: ChatTimelineItem[];
  liveMessages?: ChatStreamMessage[];
  delta?: ChatStreamDelta;
  queue?: ChatQueueState;
  settlement?: ChatStreamSettlement;
  threadTitle?: string;
  error?: string;
};

export type ChatStreamSettlement = {
  // Keep the current timeline through this persisted message, then replace the
  // remaining tail with `messages`. When omitted, the supplied messages replace
  // the whole currently loaded timeline (used for a run at the start of a chat).
  replaceAfterMessageId?: string;
  // First persisted row superseded by this run. This is only needed when the
  // retained anchor is outside the renderer's loaded page: if the stale row is
  // present, truncate from it before appending the authoritative run tail.
  replaceFromMessageId?: string;
  messages: ChatMessage[];
};

export type ChatStreamMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: PickedPath[];
  timeline?: ChatTimelineItem[];
};

// Incremental streaming update. Instead of re-sending the full growing conversation
// on every ~16ms tick, the main process sends only what changed since the last event
// for this request. The renderer reconstructs the full live-message array from its
// last snapshot. A full snapshot (via `liveMessages`) is sent as the first event of
// each request and periodically so any divergence self-heals; the run also ends with
// a database-backed refresh, so a transient delta glitch can never persist.
export type ChatStreamMessageDelta = {
  index: number;
  role: "user" | "assistant";
  contentAppend?: string;
  content?: string;
  attachments?: PickedPath[];
  timeline?: ChatTimelineItem[];
  timelineDelta?: ChatTimelineDelta;
};

export type ChatTimelineItemDelta = {
  index: number;
  item?: ChatTimelineItem;
  textAppend?: string;
  argumentsJsonAppend?: string;
  contentAppend?: string;
};

export type ChatTimelineDelta = {
  itemCount: number;
  items: ChatTimelineItemDelta[];
};

export type ChatStreamDelta = {
  messageCount: number;
  messages: ChatStreamMessageDelta[];
};

export type ChatQueueMode = "followUp" | "steer";

export type ChatQueuedMessage = {
  id: string;
  mode: ChatQueueMode;
  content: string;
  attachments?: PickedPath[];
  createdAt: string;
};

export type ChatQueueState = {
  followUp: ChatQueuedMessage[];
  steering: ChatQueuedMessage[];
};

export type AskUserQuestionOption = {
  label: string;
  description?: string;
};

export type AskUserQuestionItem = {
  id: string;
  header: string;
  question: string;
  options: AskUserQuestionOption[];
};

export type AskUserQuestionPrompt = {
  id: string;
  questions: AskUserQuestionItem[];
};

export type AskUserQuestionAnswer = {
  questionId: string;
  question: string;
  answer: string;
  custom: boolean;
  selectedIndex?: number;
  selectedOptionLabel?: string;
};

export type AskUserQuestionResponse = {
  id: string;
  answers: AskUserQuestionAnswer[];
};

export type ChatThread = {
  id: string;
  title: string;
  projectId: string | null;
  messageCount: number;
  draft?: string;
  activePluginIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceProject = {
  id: string;
  name: string;
  rootPath: string;
  threadCount: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
};

export type ToolRunStatus = "running" | "success" | "error";

export type ToolRun = {
  id: string;
  threadId: string;
  messageId?: string;
  kind: "provider_call";
  title: string;
  status: ToolRunStatus;
  providerId?: string;
  modelId?: string;
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
};

export type MemoryRecord = {
  id: string;
  content: string;
  sourceMessageId?: string;
  sourceThreadId?: string;
  archived: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MemoryReference = {
  id: string;
  content: string;
};

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  source: "local" | "external" | "plugin";
  sourcePath?: string;
  skillFilePath?: string;
  readonly?: boolean;
  pluginPackageId?: string;
  pluginPackageName?: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillReference = {
  id: string;
  name: string;
  description: string;
  instructions?: string;
};

export type PluginResourceKind = "extensions" | "skills" | "prompts" | "themes";

export type PluginResourceCount = {
  enabled: number;
  total: number;
};

export type PluginResourceCounts = Record<PluginResourceKind, PluginResourceCount>;

export type PluginPackageScope = "user" | "project";

export type PluginPackageRecord = {
  id: string;
  source: string;
  displayName: string;
  scope: PluginPackageScope;
  enabled: boolean;
  filtered: boolean;
  installedPath?: string;
  builtin?: boolean;
  recommended?: boolean;
  removable: boolean;
  updateable: boolean;
  resourceCounts: PluginResourceCounts;
};

export type PluginReference = {
  id: string;
  name: string;
  source: string;
  scope: PluginPackageScope;
  enabled: boolean;
};

export type PluginProgressEvent = {
  type: "start" | "progress" | "complete" | "error";
  action: "install" | "remove" | "update" | "clone" | "pull";
  source: string;
  message?: string;
};

export type PluginPackageInstallRequest = {
  source: string;
};

export type PluginPackageOperationRequest = {
  source: string;
  scope?: PluginPackageScope;
};

export type PluginPackageEnableRequest = PluginPackageOperationRequest & {
  enabled: boolean;
};

export type PluginResolveResourcesResponse = {
  packages: PluginPackageRecord[];
};

export type ToolModelSettings = {
  providerId: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  updatedAt: string;
};

export type AppearanceSettings = {
  accent: string;
  surface: string;
  ink: string;
  success: string;
  danger: string;
  updatedAt: string;
};

export type BrandSettings = {
  logoDataUrl: string | null;
  mainTitle: string;
  subtitle: string;
  updatedAt: string;
};

export type WorkingNotificationMode = "background" | "always" | "never";

export type WorkingNotificationSettings = {
  mode: WorkingNotificationMode;
  includeDetails: boolean;
};

export type WorkingTaskStatus =
  | "running"
  | "waiting_user"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type WorkingTask = {
  requestId: string;
  threadId: string;
  threadTitle: string;
  projectId: string | null;
  projectName: string | null;
  status: WorkingTaskStatus;
  activity: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  queueCount: number;
  unread: boolean;
};

export type WorkingSnapshot = {
  items: WorkingTask[];
  activeCount: number;
  attentionCount: number;
};

export type WorkingViewUpdateRequest = {
  threadId: string | null;
};

export type WorkingNavigationTarget = {
  requestId: string;
  threadId: string;
  projectId: string | null;
};

export type AppUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

// "automatic" installs the update in place. "manual" means the platform can
// report a newer version but cannot install it — macOS builds signed ad-hoc
// rather than with a Developer ID identity, which Squirrel.Mac rejects — so the
// app sends the user to the download page instead.
export type AppUpdateInstallMode = "automatic" | "manual";

export type AppUpdateState = {
  phase: AppUpdatePhase;
  supported: boolean;
  installMode: AppUpdateInstallMode;
  currentVersion: string;
  availableVersion: string | null;
  progressPercent: number | null;
  bytesPerSecond: number | null;
  transferredBytes: number | null;
  totalBytes: number | null;
  lastCheckedAt: string | null;
  error: string | null;
};

export type AppSettings = {
  toolModel: ToolModelSettings;
  appearance: AppearanceSettings;
  brand: BrandSettings;
  language: AppLanguage;
  workingNotifications: WorkingNotificationSettings;
  permissionMode: PermissionMode;
  fileChangeTrackingMode: FileChangeTrackingMode;
  skillEditorPath?: string;
  terminalShellPath?: string;
};

export type AppSettingsUpdateRequest = {
  toolModel?: {
    providerId?: string;
    modelId?: string;
    reasoningEffort?: ReasoningEffort;
  };
  appearance?: Partial<Pick<AppearanceSettings, "accent" | "surface" | "ink" | "success" | "danger">>;
  brand?: Partial<Pick<BrandSettings, "logoDataUrl" | "mainTitle" | "subtitle">>;
  language?: AppLanguage;
  workingNotifications?: Partial<WorkingNotificationSettings>;
  permissionMode?: PermissionMode;
  fileChangeTrackingMode?: FileChangeTrackingMode;
  skillEditorPath?: string;
  terminalShellPath?: string;
};

export type TerminalShellInfo = {
  command: string;
  args: string[];
  label: string;
  source: "configured" | "nu" | "git-bash" | "powershell" | "cmd";
};

export type TerminalSession = {
  id: string;
  shell: TerminalShellInfo;
  cwd: string;
  startedAt: string;
};

export type TerminalStartRequest = {
  cwd?: string;
  projectId?: string | null;
  threadId?: string;
  cols?: number;
  rows?: number;
};

export type TerminalInputRequest = {
  sessionId: string;
  data: string;
};

export type TerminalResizeRequest = {
  sessionId: string;
  cols: number;
  rows: number;
};

export type TerminalStopRequest = {
  sessionId: string;
};

export type TerminalEvent = {
  sessionId: string;
  type: "data" | "exit" | "error";
  data?: string;
  exitCode?: number | null;
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

export type ContextTaxonomyPartKind = "text" | "reasoning" | "tool_call" | "tool_result" | "attachment" | "refusal" | "metadata" | "unclassified";

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
  | "unclassified"
  | "unknown";

export type ContextTaxonomySegment = {
  title: string;
  kind: ContextTaxonomyKind;
  confidence: number;
  tokenEstimate: number;
  text: string;
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

export type ContextReasoningPolicyId = "deepseek-tool-interval-v1" | "kimi-k3-preserved-v1" | "kimi-k2.7-preserved-v1" | "kimi-k2.6-configurable-v1" | "kimi-k2.5-unsupported-v1" | "unknown";

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
  source: "provider-payload" | "jasmine-assembly";
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

export type FileChangeStatus = "added" | "modified" | "deleted";
export type FileChangeKind = "text" | "image" | "binary" | "other";
export type FileChangeTrackingMode = "managed-tools-only" | "watcher";
export type FileChangeProvenance = "observed-between-checkpoints";

export type FileChangeCoverageRoot = {
  id: string;
  path: string;
  physicalPath: string;
  source: "cwd" | "configured" | "write-target" | "watcher";
  scope: "recursive" | "file" | "watcher";
  filePath?: string;
  requestedPath?: string;
  requestedFilePath?: string;
  bashCovered: boolean;
};

export type FileChangeCoverageIssue = {
  code: string;
  stage: "baseline" | "final";
  rootId: string;
  root: string;
  path?: string;
  message: string;
};

export type FileChangeCoverage = {
  status: "complete" | "partial" | "failed" | "unsupported";
  target: "local";
  reason?: string;
  scannedFiles?: number;
  scannedBytes?: number;
  trackingMode?: FileChangeTrackingMode;
  bashCoverage?: "agent-start-roots-only" | "not-tracked" | "watcher-observed";
  bashInvoked?: boolean;
  omittedWarningCount?: number;
  omittedIssueCount?: number;
  rootDetails?: FileChangeCoverageRoot[];
  issues?: FileChangeCoverageIssue[];
  limits?: {
    maxFiles?: number;
    maxTotalBytes?: number;
    maxContentBytes: number;
    maxCapturedContentBytes?: number;
    maxRunCapturedContentBytes?: number;
    maxRoots?: number;
    maxManagedTargets?: number;
    maxChanges?: number;
    appliesPerRootSnapshot?: true;
    appliesPerObservedFile?: true;
  };
};

export type FileChangeRevision = {
  sha256: string;
  size: number;
  mediaType?: string;
  encoding?: "utf8" | "base64";
  mode?: string;
  content?: string;
  contentTruncated?: boolean;
  redacted?: boolean;
};

export type FileChangeInput = {
  status: FileChangeStatus;
  kind: FileChangeKind;
  path: string;
  root: string;
  relativePath: string;
  before?: FileChangeRevision;
  after?: FileChangeRevision;
  unifiedDiff?: string;
  diffTruncated?: boolean;
  provenance: FileChangeProvenance;
};

/** Host-neutral payload produced by the Pi file-change package. */
export type FileChangeCaptureInput = {
  producerCaptureId?: string;
  schemaVersion: number;
  startedAt: string;
  completedAt: string;
  /** Alias retained for package/protocol consumers that use a single timestamp. */
  capturedAt?: string;
  cwd: string;
  roots: string[];
  excludes: string[];
  warnings: string[];
  coverage: FileChangeCoverage;
  changes: FileChangeInput[];
};

export type FileChangeRevisionSummary = Omit<FileChangeRevision, "content"> & {
  contentAvailable: boolean;
};

/** Added/removed line totals of the stored unified diff, counted once at capture time. */
export type FileChangeLineStats = {
  added: number;
  deleted: number;
};

export type FileChangeSummary = {
  id: string;
  captureId: string;
  status: FileChangeStatus;
  kind: FileChangeKind;
  path: string;
  root: string;
  relativePath: string;
  before?: FileChangeRevisionSummary;
  after?: FileChangeRevisionSummary;
  hasUnifiedDiff: boolean;
  diffTruncated: boolean;
  lineStats?: FileChangeLineStats;
  provenance: FileChangeProvenance;
};

export type FileChangeCaptureSummary = {
  id: string;
  producerCaptureId?: string;
  threadId: string;
  messageId?: string;
  runId: string;
  schemaVersion: number;
  startedAt: string;
  completedAt: string;
  capturedAt: string;
  cwd: string;
  roots: string[];
  excludes: string[];
  warnings: string[];
  coverage: FileChangeCoverage;
  changes: FileChangeSummary[];
};

export type FileChangeDetail = Omit<FileChangeSummary, "before" | "after" | "hasUnifiedDiff"> & {
  before?: FileChangeRevision;
  after?: FileChangeRevision;
  unifiedDiff?: string;
};

export type ThreadArtifactsResponse = {
  threadId: string;
  captures: FileChangeCaptureSummary[];
};

export type ThreadArtifactDetailResponse = {
  change: FileChangeDetail;
};

export type ThreadContextTaxonomyResponse = {
  threadId: string;
  captures: Array<{
    id: string;
    messageId: string;
    runId: string | null;
    createdAt: string;
    provider: string;
    model: string;
    source: ContextTaxonomy["source"];
    schemaVersion: number;
    taskIndex: number;
    requestIndex: number;
    requestCount: number;
    rawState: ContextRawPayloadState;
    rawSha256: string | null;
    rawCharCount: number;
    rawByteCount: number;
    cacheMetrics?: ContextCacheMetrics;
    reasoningValidation?: ContextReasoningValidation;
  }>;
};

export type ContextTaxonomyDetailResponse = {
  captureId: string;
  taxonomy: ContextTaxonomy;
};

export type ContextTaxonomyRawRequest = {
  captureId: string;
  offset?: number;
  length?: number;
};

export type ContextTaxonomyRawResponse = {
  captureId: string;
  state: ContextRawPayloadState;
  offset: number;
  totalChars: number;
  text: string;
  done: boolean;
  sha256: string | null;
};

export type ChatSendRequest = {
  requestId?: string;
  threadId: string;
  providerId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  memoryEnabled?: boolean;
  toolsEnabled?: boolean;
  captureContextTaxonomy?: boolean;
  skillIds?: string[];
  inlineSkillIds?: string[];
  inlinePluginIds?: string[];
  messages: Array<Pick<ChatMessage, "role" | "content" | "timeline" | "attachments">>;
  content: string;
  attachments?: PickedPath[];
};

export type ChatSendResponse = {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  content: string;
  model: string;
  elapsedMs: number;
};

export type ChatRetryRequest = {
  requestId?: string;
  threadId: string;
  providerId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  memoryEnabled?: boolean;
  toolsEnabled?: boolean;
  captureContextTaxonomy?: boolean;
  skillIds?: string[];
  messageId?: string;
};

export type ChatRetryResponse = {
  assistantMessage: ChatMessage;
  content: string;
  model: string;
  elapsedMs: number;
};

export type ChatEditRequest = {
  requestId?: string;
  threadId: string;
  messageId: string;
  providerId?: string;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
  memoryEnabled?: boolean;
  toolsEnabled?: boolean;
  captureContextTaxonomy?: boolean;
  skillIds?: string[];
  inlineSkillIds?: string[];
  inlinePluginIds?: string[];
  content: string;
  attachments?: PickedPath[];
};

export type ChatEditResponse = {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  content: string;
  model: string;
  elapsedMs: number;
};

export type ChatQueueRequest = {
  requestId: string;
  threadId: string;
  mode: ChatQueueMode;
  content: string;
  attachments?: PickedPath[];
};

export type ChatQueueUpdateRequest = {
  requestId: string;
  threadId: string;
  messageId: string;
  content: string;
  attachments?: PickedPath[];
};

export type ChatQueueDeleteRequest = {
  requestId: string;
  threadId: string;
  messageId: string;
};

export type ChatQueueSteerRequest = {
  requestId: string;
  threadId: string;
  messageId: string;
};

export type ChatQueueResponse = {
  queue: ChatQueueState;
};

export type ChatContextTaxonomyCaptureUpdateRequest = {
  threadId: string;
  enabled: boolean;
};

export type PickedPath = {
  name: string;
  path: string;
  kind: "file" | "folder";
  mediaType?: string;
  isImage?: boolean;
  previewDataUrl?: string;
};

/**
 * What the chat renderer knows about a path an assistant answer referenced.
 * Carries no file bytes: image content reaches the renderer over the
 * `jasmine-file://` protocol so Chromium owns decoding and caching.
 */
export type LocalFileDescription = {
  /** Exactly as written in the message, so the renderer can match it back. */
  requestedPath: string;
  /** Absolute and home-expanded; the form every action is performed against. */
  path: string;
  name: string;
  exists: boolean;
  kind: "file" | "directory" | "missing";
  size?: number;
  mediaType?: string;
  /** True only when the file can actually be painted inline at its size. */
  isImage?: boolean;
};

export type ClipboardImagePasteRequest = {
  name?: string;
  mimeType?: string;
  data: ArrayBuffer;
};

export type FileSearchRequest = {
  query: string;
  cwd?: string;
  projectId?: string | null;
  limit?: number;
};

export type FileSearchResult = {
  name: string;
  path: string;
  relativePath: string;
  kind: "file";
  score: number;
};

export type ExecutablePickerKind = "editor" | "terminal";

export type ExecutableCandidateSource = "path" | "app-paths" | "common-path" | "system" | "configured" | "e2e";

export type ExecutableCandidate = {
  label: string;
  command: string;
  source: ExecutableCandidateSource;
};

export type ExecutableDiscovery = {
  kind: ExecutablePickerKind;
  auto?: ExecutableCandidate;
  candidates: ExecutableCandidate[];
};

export type ProviderStatus = "unchecked" | "connected" | "missing_key" | "failed";

export type ModelCapabilities = {
  vision: boolean;
  imageOutput: boolean;
  toolCalling: boolean;
  reasoning: boolean;
  embedding: boolean;
};

export type ProviderModelConfig = {
  id: string;
  enabled: boolean;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxOutputTokens: number;
  providerOptionsJson: string;
  customized?: boolean;
  metadataSource?: string;
  metadataRefreshedAt?: string;
};

export type AiProvider = {
  id: string;
  name: string;
  type: "openai-compatible";
  baseUrl: string;
  apiKeyRef: string;
  models: ProviderModelConfig[];
  defaultModel: string;
  enabled: boolean;
  status: ProviderStatus;
  lastCheckedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProviderUpdateRequest = {
  id: string;
  baseUrl?: string;
  apiKeyRef?: string;
  defaultModel?: string;
  enabled?: boolean;
};

export type ProviderTestResponse = {
  provider: AiProvider;
  status: ProviderStatus;
  elapsedMs?: number;
};

export type ProviderModelsResponse = {
  provider: AiProvider;
  models: ProviderModelConfig[];
};

export type ProviderModelUpdateRequest = {
  providerId: string;
  modelId: string;
  enabled?: boolean;
  capabilities?: Partial<ModelCapabilities>;
  contextWindow?: number;
  maxOutputTokens?: number;
  providerOptionsJson?: string;
};

export type MemoryListRequest = {
  includeArchived?: boolean;
};

export type MemoryCreateRequest = {
  content: string;
  sourceMessageId?: string;
  sourceThreadId?: string;
};

export type MemoryUpdateRequest = {
  id: string;
  content: string;
};

export type MemoryArchiveRequest = {
  id: string;
  archived: boolean;
};

export type SkillCreateRequest = {
  name?: string;
  description?: string;
  instructions?: string;
  enabled?: boolean;
};

export type SkillUpdateRequest = {
  id: string;
  name?: string;
  description?: string;
  instructions?: string;
  enabled?: boolean;
};

export type SkillOpenResponse = {
  skill: SkillRecord;
  editorPath?: string;
  openedPath: string;
};

export type SkillSource = {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type SkillSourceCreateRequest = {
  path: string;
};

export type PromptTemplateRecord = {
  name: string;
  description: string;
  argumentHint?: string;
  filePath: string;
  sourceScope?: string;
};

export type PromptTemplateSource = {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type PromptTemplateSourceCreateRequest = {
  path: string;
};

export type ActivityStatus = "disabled" | "running" | "paused";

export type ActivitySettings = {
  enabled: boolean;
  paused: boolean;
  localOnly: boolean;
  captureWindowTitles: boolean;
  captureScreenshots: boolean;
  retentionDays: number;
  updatedAt: string;
};

export type ActivityObservation = {
  id: string;
  note: string;
  source: "manual";
  createdAt: string;
};

export type ActivitySettingsUpdateRequest = {
  enabled?: boolean;
  paused?: boolean;
  localOnly?: boolean;
  captureWindowTitles?: boolean;
  captureScreenshots?: boolean;
  retentionDays?: number;
};

export type ActivityObservationListRequest = {
  query?: string;
};

export type ActivityObservationCreateRequest = {
  note: string;
};

export type ActivitySnapshot = {
  settings: ActivitySettings;
  observations: ActivityObservation[];
  status: ActivityStatus;
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type ThreadRenameRequest = {
  id: string;
  title: string;
};

export type ThreadCreateRequest = {
  title?: string;
  projectId?: string | null;
};

export type ThreadDraftUpdateRequest = {
  threadId: string;
  content: string;
};

export type ThreadActivePluginsUpdateRequest = {
  threadId: string;
  pluginIds: string[];
};

export type ProjectCreateFromPathRequest = {
  path: string;
};

export type ProjectRenameRequest = {
  id: string;
  name: string;
};

export type ProjectRemoveRequest = {
  id: string;
};

export type ProjectOpenInExplorerRequest = {
  id: string;
};

export type MessageListRequest = {
  threadId: string;
  limit?: number;
  before?: {
    id: string;
    createdAt: string;
  };
};

export type ThreadContextUsageRequest = {
  threadId: string;
  providerId?: string;
  modelId?: string;
};

export type ThreadContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export type WindowState = {
  maximized: boolean;
  fullScreen: boolean;
};

export type SpotlightCommandId = "open-thread" | "new-chat" | "open-settings";

export type SpotlightItem = {
  id: string;
  commandId: SpotlightCommandId;
  label: string;
  description?: string;
  group?: string;
  keywords?: string[];
  threadId?: string;
  projectId?: string | null;
  section?: string;
};

export type SpotlightSearchRequest = {
  query: string;
};

export type SpotlightSearchResponse = {
  items: SpotlightItem[];
};

export type SpotlightExecuteRequest = {
  commandId: SpotlightCommandId;
  threadId?: string;
  projectId?: string | null;
  section?: string;
};

export type JasmineApi = {
  platform: NodeJS.Platform;
  listThreads(): Promise<ChatThread[]>;
  createThread(input?: ThreadCreateRequest): Promise<ChatThread>;
  renameThread(request: ThreadRenameRequest): Promise<ChatThread>;
  deleteThread(threadId: string): Promise<void>;
  deleteThreads(threadIds: string[]): Promise<void>;
  getThreadDraft(threadId: string): Promise<string>;
  updateThreadDraft(request: ThreadDraftUpdateRequest): Promise<void>;
  updateThreadActivePlugins(request: ThreadActivePluginsUpdateRequest): Promise<ChatThread>;
  getThreadContextUsage(request: ThreadContextUsageRequest): Promise<ThreadContextUsage>;
  listProjects(): Promise<WorkspaceProject[]>;
  openProjectFolder(): Promise<WorkspaceProject | null>;
  createProjectFromPath(request: ProjectCreateFromPathRequest): Promise<WorkspaceProject>;
  renameProject(request: ProjectRenameRequest): Promise<WorkspaceProject>;
  removeProject(request: ProjectRemoveRequest): Promise<void>;
  openProjectInExplorer(request: ProjectOpenInExplorerRequest): Promise<void>;
  onProjectOpened(callback: (project: WorkspaceProject) => void): () => void;
  getWorkingSnapshot(): Promise<WorkingSnapshot>;
  markWorkingRead(requestId: string): Promise<WorkingSnapshot>;
  clearCompletedWorking(): Promise<WorkingSnapshot>;
  stopWorkingTask(requestId: string): Promise<boolean>;
  updateWorkingView(request: WorkingViewUpdateRequest): Promise<void>;
  consumePendingWorkingNavigation(): Promise<WorkingNavigationTarget | null>;
  onWorkingChanged(callback: (snapshot: WorkingSnapshot) => void): () => void;
  onWorkingNavigate(callback: (target: WorkingNavigationTarget) => void): () => void;
  listMessages(request: string | MessageListRequest): Promise<ChatMessage[]>;
  sendChatMessage(request: ChatSendRequest): Promise<ChatSendResponse>;
  retryChatMessage(request: ChatRetryRequest): Promise<ChatRetryResponse>;
  editChatMessage(request: ChatEditRequest): Promise<ChatEditResponse>;
  queueChatMessage(request: ChatQueueRequest): Promise<ChatQueueResponse>;
  updateQueuedChatMessage(request: ChatQueueUpdateRequest): Promise<ChatQueueResponse>;
  deleteQueuedChatMessage(request: ChatQueueDeleteRequest): Promise<ChatQueueResponse>;
  steerQueuedChatMessage(request: ChatQueueSteerRequest): Promise<ChatQueueResponse>;
  updateChatContextTaxonomyCapture(request: ChatContextTaxonomyCaptureUpdateRequest): Promise<boolean>;
  cancelChatMessage(requestId: string): Promise<boolean>;
  answerAskUserQuestion(request: AskUserQuestionResponse): Promise<void>;
  answerPermissionApproval(request: PermissionApprovalResponse): Promise<void>;
  onChatStream(callback: (event: ChatStreamEvent) => void): () => void;
  onAskUserQuestion(callback: (prompt: AskUserQuestionPrompt) => void): () => void;
  onAskUserQuestionCancelled(callback: (id: string) => void): () => void;
  onPermissionApproval(callback: (prompt: PermissionApprovalPrompt) => void): () => void;
  onPermissionApprovalCancelled(callback: (id: string) => void): () => void;
  listTracesForThread(threadId: string): Promise<ToolRun[]>;
  listTracesForMessage(messageId: string): Promise<ToolRun[]>;
  getTrace(runId: string): Promise<ToolRun>;
  listMemories(request?: MemoryListRequest): Promise<MemoryRecord[]>;
  createMemory(request: MemoryCreateRequest): Promise<MemoryRecord>;
  updateMemory(request: MemoryUpdateRequest): Promise<MemoryRecord>;
  archiveMemory(request: MemoryArchiveRequest): Promise<MemoryRecord>;
  deleteMemory(id: string): Promise<void>;
  listSkills(): Promise<SkillRecord[]>;
  createSkill(request: SkillCreateRequest): Promise<SkillRecord>;
  updateSkill(request: SkillUpdateRequest): Promise<SkillRecord>;
  deleteSkill(id: string): Promise<void>;
  openSkill(id: string): Promise<SkillOpenResponse>;
  listSkillSources(): Promise<SkillSource[]>;
  addSkillSource(request: SkillSourceCreateRequest): Promise<SkillSource>;
  deleteSkillSource(id: string): Promise<void>;
  pickSkillFolders(): Promise<string[]>;
  listExecutableDiscovery(kind: ExecutablePickerKind): Promise<ExecutableDiscovery>;
  pickExecutable(kind: ExecutablePickerKind): Promise<string | null>;
  listPromptTemplates(): Promise<PromptTemplateRecord[]>;
  listPromptTemplateSources(): Promise<PromptTemplateSource[]>;
  addPromptTemplateSource(request: PromptTemplateSourceCreateRequest): Promise<PromptTemplateSource>;
  deletePromptTemplateSource(id: string): Promise<void>;
  pickPromptTemplatePaths(): Promise<string[]>;
  listPlugins(): Promise<PluginPackageRecord[]>;
  listPluginSkills(): Promise<SkillRecord[]>;
  installPlugin(request: PluginPackageInstallRequest): Promise<PluginPackageRecord[]>;
  updatePlugin(request: PluginPackageOperationRequest): Promise<PluginPackageRecord[]>;
  removePlugin(request: PluginPackageOperationRequest): Promise<PluginPackageRecord[]>;
  setPluginEnabled(request: PluginPackageEnableRequest): Promise<PluginPackageRecord[]>;
  resolvePluginResources(): Promise<PluginResolveResourcesResponse>;
  getAppSettings(): Promise<AppSettings>;
  updateAppSettings(request: AppSettingsUpdateRequest): Promise<AppSettings>;
  getAppUpdateState(): Promise<AppUpdateState>;
  checkForAppUpdate(): Promise<AppUpdateState>;
  downloadAppUpdate(): Promise<AppUpdateState>;
  installAppUpdate(): Promise<AppUpdateState>;
  openAppUpdateDownloadPage(): Promise<AppUpdateState>;
  onAppUpdateStateChanged(callback: (state: AppUpdateState) => void): () => void;
  resolveTerminalShell(): Promise<TerminalShellInfo>;
  startTerminal(request?: TerminalStartRequest): Promise<TerminalSession>;
  writeTerminal(request: TerminalInputRequest): Promise<void>;
  resizeTerminal(request: TerminalResizeRequest): Promise<void>;
  stopTerminal(request: TerminalStopRequest): Promise<void>;
  onTerminalEvent(callback: (event: TerminalEvent) => void): () => void;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
  listThreadArtifacts(threadId: string): Promise<ThreadArtifactsResponse>;
  getThreadArtifactDetail(threadId: string, changeId: string): Promise<ThreadArtifactDetailResponse>;
  listThreadContextTaxonomy(threadId: string): Promise<ThreadContextTaxonomyResponse>;
  getContextTaxonomy(captureId: string): Promise<ContextTaxonomyDetailResponse>;
  getContextTaxonomyRaw(request: ContextTaxonomyRawRequest): Promise<ContextTaxonomyRawResponse>;
  getActivitySettings(): Promise<ActivitySettings>;
  updateActivitySettings(request: ActivitySettingsUpdateRequest): Promise<ActivitySettings>;
  listActivityObservations(request?: ActivityObservationListRequest): Promise<ActivityObservation[]>;
  createManualActivityObservation(request: ActivityObservationCreateRequest): Promise<ActivityObservation>;
  listProviders(): Promise<AiProvider[]>;
  updateProvider(request: ProviderUpdateRequest): Promise<AiProvider>;
  testProvider(providerId: string): Promise<ProviderTestResponse>;
  fetchProviderModels(providerId: string): Promise<ProviderModelsResponse>;
  updateProviderModel(request: ProviderModelUpdateRequest): Promise<AiProvider>;
  searchFiles(request: FileSearchRequest): Promise<FileSearchResult[]>;
  pickFileFromPath(path: string): Promise<PickedPath>;
  pickFile(): Promise<PickedPath | null>;
  savePastedImage(request: ClipboardImagePasteRequest): Promise<PickedPath>;
  pickClipboardImage(): Promise<PickedPath | null>;
  pickFolder(title?: string): Promise<PickedPath | null>;
  describeLocalFiles(paths: string[]): Promise<LocalFileDescription[]>;
  openLocalPath(path: string): Promise<void>;
  revealLocalPath(path: string): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  windowAction(action: "minimize" | "maximize" | "close"): Promise<void>;
  getWindowState(): Promise<WindowState>;
  onWindowStateChanged(callback: (state: WindowState) => void): () => void;
  spotlightSearch(request: SpotlightSearchRequest): Promise<SpotlightSearchResponse>;
  spotlightExecute(request: SpotlightExecuteRequest): Promise<void>;
  spotlightConsumePending(): Promise<SpotlightExecuteRequest | null>;
  spotlightClose(): Promise<void>;
  onSpotlightReset(callback: () => void): () => void;
  onSpotlightCommand(callback: (payload: SpotlightExecuteRequest) => void): () => void;
};
