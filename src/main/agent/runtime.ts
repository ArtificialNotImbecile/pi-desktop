import { existsSync } from "node:fs";
import path from "node:path";
import type { AskUserQuestionPrompt, AskUserQuestionResponse, ChatQueueMode, ChatQueueState, ChatSendRequest, ChatTimelineItem, ContextTaxonomy, ContextTaxonomyKind, ModelCapabilities, PickedPath, RemoteConnectionRecord, WebSearchProvider, WebSearchResult } from "../../shared/ipc.js";
import type { RuntimeSkillManifest } from "../services/skillManifests.js";
import { chatSendRequestSchema } from "../../shared/schemas.js";
import { providerPayloadToContextTaxonomy, taxonomyItem, withContextCacheMetrics } from "./extensions/contextCapture/classifier.js";
import { CONTEXT_TAXONOMY_SCHEMA_VERSION } from "./extensions/contextCapture/schema.js";
import { findGitBashPath, isWindowsBashLauncherPath } from "../utils/shellPaths.js";
import { abortError, isAbortError, throwIfAborted } from "../utils/abort.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

export type AssistantReply = {
  content: string;
  model: string;
  elapsedMs: number;
  timeline: ChatTimelineItem[];
  webSearchUsed: WebSearchResult[];
  contextTaxonomy?: ContextTaxonomy;
  contextTaxonomies?: ContextTaxonomy[];
  generatedMessages?: RuntimeGeneratedMessage[];
};

export type RuntimeProviderConfig = {
  providerName: string;
  apiKey: string;
  baseUrl: string;
  modelId: string;
  capabilities?: ModelCapabilities;
  providerOptionsJson?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
};

type RuntimeChatRequest = ChatSendRequest & {
  cwd?: string;
  memoryContext?: string[];
  skillContext?: RuntimeSkillManifest[];
  packageSkillPaths?: string[];
  packageExtensionPaths?: string[];
  chromeTakeover?: {
    enabled: boolean;
    bridgeFilePath?: string;
    extensionId?: string;
  };
  piAgentDir?: string;
  webSearchContext?: WebSearchResult[];
  terminalShellPath?: string;
  webSearchTool?: {
    enabled: boolean;
    provider: WebSearchProvider;
    search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]>;
  };
  askUserQuestion?: (prompt: Omit<AskUserQuestionPrompt, "id">, signal?: AbortSignal) => Promise<AskUserQuestionResponse>;
  promptTemplatePaths?: string[];
  remoteConnection?: RemoteConnectionRecord | null;
  sessionManager?: SessionManager;
  sessionMessageIds?: string[];
  currentMessageId?: string;
  branchBeforePromptEntryId?: string | null;
  onSessionEntriesLinked?(links: Array<{ messageId: string; sessionEntryId: string }>): void;
};

export type RuntimeUpdate = Pick<AssistantReply, "content" | "timeline"> & {
  liveMessages?: RuntimeGeneratedMessage[];
};

export type RuntimeQueuedMessageInput = {
  mode: ChatQueueMode;
  content: string;
  attachments: PickedPath[];
};

export type RuntimeQueuedMessageUpdate = {
  id: string;
  content: string;
  attachments: PickedPath[];
};

export type RuntimeQueueControls = {
  queueMessage(input: RuntimeQueuedMessageInput): Promise<ChatQueueState>;
  updateMessage(input: RuntimeQueuedMessageUpdate): Promise<ChatQueueState>;
  deleteMessage(id: string): Promise<ChatQueueState>;
  steerMessage(id: string): Promise<ChatQueueState>;
};

export type RuntimeGeneratedMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: PickedPath[];
  timeline?: ChatTimelineItem[];
  sessionEntryId?: string;
};

export type RuntimeOptions = {
  signal?: AbortSignal;
  onUpdate?(update: RuntimeUpdate): void;
  onQueueReady?(controls: RuntimeQueueControls): void;
  onQueueUpdate?(queue: ChatQueueState): void;
};

export async function generateAssistantReply(request: RuntimeChatRequest, provider: RuntimeProviderConfig, options: RuntimeOptions = {}): Promise<AssistantReply> {
  const parsed = chatSendRequestSchema.parse(request);
  applyChromeTakeoverRuntimeEnv(request.chromeTakeover);
  const startedAt = Date.now();
  assertSupportedAttachments(parsed.messages, request.attachments ?? [], parsed.content, provider);
  const piShell = resolvePiShellRuntime(request.terminalShellPath);
  const cwd = request.cwd?.trim() || process.cwd();
  const systemPrompt = buildSystemPrompt(request.memoryContext ?? [], request.skillContext ?? [], request.webSearchContext ?? [], request.toolsEnabled ?? true, {
    cwd,
    piShell
  });
  if (process.env.JASMINE_E2E_MOCK_AI === "1") {
    const mockSession = prepareMockSession(request, provider, parsed.content);
    const mockQueue = createMockQueueControls(options);
    const imageCount = countModelVisibleImages(parsed.messages, request.attachments ?? [], parsed.content);
    const lastUserText = parsed.content || parsed.messages.at(-1)?.content || "";
    const inlineSkillNames = (request.skillContext ?? [])
      .filter((skill) => (parsed.inlineSkillIds ?? []).includes(skill.id))
      .map((skill) => skill.name);
    const remotePrefix = request.remoteConnection?.active && request.toolsEnabled ? `Remote coding target: ${request.remoteConnection.name}. ` : "";
    const content = remotePrefix + mockContent(lastUserText, imageCount, request.toolsEnabled ?? true, request.memoryContext ?? [], request.skillContext ?? [], inlineSkillNames, request.webSearchContext ?? []);
    const latestUpdate: { current?: RuntimeUpdate } = {};
    const onUpdate = options.onUpdate
      ? (update: RuntimeUpdate) => {
          latestUpdate.current = update;
          options.onUpdate?.(update);
        }
      : undefined;
    try {
      if (lastUserText.toLowerCase().includes("slow response")) await abortableDelay(750, options.signal);
      await streamMockReply(content, lastUserText, request.toolsEnabled ?? true, request.webSearchContext ?? [], {
        modelId: provider.modelId,
        reasoningEffort: parsed.reasoningEffort,
        ...options,
        onUpdate
      });
      const initialAssistantEntryId = appendMockAssistant(mockSession, provider, content);
      mockQueue.generatedMessages.push({
        role: "assistant",
        content,
        timeline: mockTimeline(content, lastUserText, request.toolsEnabled ?? true, request.webSearchContext ?? [], {
          modelId: provider.modelId,
          reasoningEffort: parsed.reasoningEffort
        }),
        ...(initialAssistantEntryId ? { sessionEntryId: initialAssistantEntryId } : {})
      });
      await drainMockQueue(mockQueue, request, provider, options, content, lastUserText, mockSession);
    } catch (error) {
      if (!isAbortError(error)) throw error;
      const stoppedContent = latestUpdate.current?.content || "Response stopped.";
      const stoppedTimeline = [...(latestUpdate.current?.timeline ?? [])];
      if (!stoppedTimeline.some((item) => item.kind === "assistant_text")) {
        stoppedTimeline.push({ id: "mock-stopped-output", kind: "assistant_text", text: stoppedContent });
      }
      stoppedTimeline.push({ id: "mock-stopped", kind: "system", title: "Stopped", text: "The response was stopped by the user." });
      const stoppedEntryId = appendMockAssistant(mockSession, provider, stoppedContent, "aborted");
      return {
        content: stoppedContent,
        model: provider.modelId,
        elapsedMs: Date.now() - startedAt,
        timeline: stoppedTimeline,
        webSearchUsed: request.webSearchContext ?? [],
        contextTaxonomy: buildAssemblyTaxonomy({
          provider,
          systemPrompt,
          messages: request.messages,
          content: parsed.content,
          attachments: request.attachments ?? [],
          reason: "mock"
        }),
        generatedMessages: [{
          role: "assistant",
          content: stoppedContent,
          timeline: stoppedTimeline,
          ...(stoppedEntryId ? { sessionEntryId: stoppedEntryId } : {})
        }]
      };
    }
    const structuredTaxonomy = lastUserText.toLowerCase().includes("structured taxonomy")
      ? mockStructuredTaxonomy(provider, lastUserText.toLowerCase().includes("unclassified taxonomy"))
      : null;
    const mockTaxonomy = structuredTaxonomy ?? buildAssemblyTaxonomy({
      provider,
      systemPrompt,
      messages: request.messages,
      content: parsed.content,
      attachments: request.attachments ?? [],
      reason: "mock"
    });
    const mockTaxonomies = structuredTaxonomy
      ? [1, 2].map((index) => ({ ...structuredTaxonomy, providerRequest: { index, count: 2, taskIndex: 1, policy: "task-capture" as const } }))
      : [mockTaxonomy];
    return {
      content,
      model: provider.modelId,
      elapsedMs: Date.now() - startedAt,
      timeline: mockTimeline(content, lastUserText, request.toolsEnabled ?? true, request.webSearchContext ?? [], {
        modelId: provider.modelId,
        reasoningEffort: parsed.reasoningEffort
      }),
      webSearchUsed: request.webSearchContext ?? [],
      contextTaxonomy: mockTaxonomies.at(-1),
      contextTaxonomies: mockTaxonomies,
      generatedMessages: mockQueue.generatedMessages
    };
  }

  const { runPiCodingAgentChat } = await import("./providers/piCodingAgent.js");
  const capturedTaxonomies: ContextTaxonomy[] = [];
  const result = await runPiCodingAgentChat({
    provider,
    messages: request.messages,
    content: parsed.content,
    attachments: request.attachments ?? [],
    systemPrompt,
    cwd,
    agentDir: request.piAgentDir,
    toolsEnabled: request.toolsEnabled ?? true,
    reasoningEffort: request.reasoningEffort,
    webSearchTool: request.webSearchTool,
    askUserQuestion: request.askUserQuestion,
    skillContext: request.skillContext ?? [],
    packageSkillPaths: request.packageSkillPaths ?? [],
    packageExtensionPaths: request.packageExtensionPaths ?? [],
    promptTemplatePaths: request.promptTemplatePaths,
    remoteConnection: request.remoteConnection,
    shellPath: piShell.shellPath,
    signal: options.signal,
    onUpdate: options.onUpdate,
    onQueueReady: options.onQueueReady,
    onQueueUpdate: options.onQueueUpdate,
    sessionManager: request.sessionManager,
    sessionMessageIds: request.sessionMessageIds,
    currentMessageId: request.currentMessageId,
    branchBeforePromptEntryId: request.branchBeforePromptEntryId,
    onSessionEntriesLinked: request.onSessionEntriesLinked,
    onContextTaxonomy: (taxonomy) => {
      capturedTaxonomies.push(taxonomy);
    }
  });

  const normalizedResult = normalizeEmptyAssistantResult(result, provider, request.reasoningEffort);
  if (capturedTaxonomies.length === 0) {
    console.warn("[context-taxonomy] Falling back to Jasmine assembly taxonomy because no Pi provider payload capture was emitted.");
  }

  const scopedTaxonomies = groupProviderRequestCaptures(capturedTaxonomies);
  const fallbackTaxonomy = capturedTaxonomies.length === 0
    ? buildAssemblyTaxonomy({
        provider,
        systemPrompt,
        messages: request.messages,
        content: parsed.content,
        attachments: request.attachments ?? [],
        reason: "no-capture"
      })
    : undefined;

  return {
    content: normalizedResult.content,
    model: provider.modelId,
    elapsedMs: Date.now() - startedAt,
    timeline: normalizedResult.timeline,
    webSearchUsed: result.webSearchUsed,
    contextTaxonomy: scopedTaxonomies.at(-1) ?? fallbackTaxonomy,
    contextTaxonomies: scopedTaxonomies.length > 0 ? scopedTaxonomies : fallbackTaxonomy ? [fallbackTaxonomy] : [],
    generatedMessages: result.generatedMessages
  };
}

function applyChromeTakeoverRuntimeEnv(chromeTakeover: RuntimeChatRequest["chromeTakeover"]): void {
  if (chromeTakeover?.enabled && chromeTakeover.bridgeFilePath) {
    process.env.JASMINE_CHROME_TAKEOVER = "1";
    process.env.JASMINE_CHROME_BRIDGE_FILE = chromeTakeover.bridgeFilePath;
    return;
  }
  process.env.JASMINE_CHROME_TAKEOVER = "0";
}

function prepareMockSession(
  request: RuntimeChatRequest,
  provider: RuntimeProviderConfig,
  currentContent: string
): SessionManager | undefined {
  const sessionManager = request.sessionManager;
  if (!sessionManager) return undefined;

  const alreadyHasMessages = sessionManager.getEntries().some((entry) => entry.type === "message");
  if (!alreadyHasMessages) {
    const last = request.messages.at(-1);
    const history = last?.role === "user" && last.content.trim() === currentContent.trim()
      ? request.messages.slice(0, -1)
      : request.messages;
    const links: Array<{ messageId: string; sessionEntryId: string }> = [];
    history.forEach((message, index) => {
      const sessionEntryId = message.role === "user"
        ? appendMockUser(sessionManager, message.content)
        : appendMockAssistant(sessionManager, provider, message.content);
      const messageId = request.sessionMessageIds?.[index];
      if (messageId && sessionEntryId) links.push({ messageId, sessionEntryId });
    });
    if (links.length > 0) request.onSessionEntriesLinked?.(links);
  } else if (request.branchBeforePromptEntryId !== undefined) {
    if (request.branchBeforePromptEntryId === null) sessionManager.resetLeaf();
    else sessionManager.branch(request.branchBeforePromptEntryId);
  }

  const currentEntryId = appendMockUser(sessionManager, currentContent);
  if (currentEntryId && request.currentMessageId) {
    request.onSessionEntriesLinked?.([{ messageId: request.currentMessageId, sessionEntryId: currentEntryId }]);
  }
  return sessionManager;
}

function appendMockUser(sessionManager: SessionManager | undefined, content: string): string | undefined {
  if (!sessionManager) return undefined;
  return sessionManager.appendMessage({
    role: "user",
    content,
    timestamp: Date.now()
  } satisfies Message);
}

function appendMockAssistant(
  sessionManager: SessionManager | undefined,
  provider: RuntimeProviderConfig,
  content: string,
  stopReason: AssistantMessage["stopReason"] = "stop"
): string | undefined {
  if (!sessionManager) return undefined;
  return sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "openai-completions",
    provider: provider.providerName,
    model: provider.modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason,
    timestamp: Date.now()
  } satisfies AssistantMessage);
}

function createMockQueueControls(options: RuntimeOptions): {
  queue: ChatQueueState;
  generatedMessages: RuntimeGeneratedMessage[];
} {
  const state = {
    queue: emptyQueueState(),
    generatedMessages: [] as RuntimeGeneratedMessage[]
  };
  options.onQueueReady?.({
    async queueMessage(input) {
      const queued = {
        id: `mock-queue-${crypto.randomUUID()}`,
        mode: input.mode,
        content: input.content.trim(),
        attachments: input.attachments,
        createdAt: new Date().toISOString()
      };
      if (input.mode === "steer") state.queue.steering.push(queued);
      else state.queue.followUp.push(queued);
      options.onQueueUpdate?.(cloneQueueState(state.queue));
      return cloneQueueState(state.queue);
    },
    async updateMessage(input) {
      const queued = findQueuedMessage(state.queue.followUp, input.id);
      if (!queued) throw new Error("Queued message is no longer editable.");
      queued.content = input.content.trim();
      queued.attachments = input.attachments;
      options.onQueueUpdate?.(cloneQueueState(state.queue));
      return cloneQueueState(state.queue);
    },
    async deleteMessage(id) {
      if (!removeQueuedMessage(state.queue.followUp, id)) throw new Error("Queued message is no longer deletable.");
      options.onQueueUpdate?.(cloneQueueState(state.queue));
      return cloneQueueState(state.queue);
    },
    async steerMessage(id) {
      const index = state.queue.followUp.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Queued message is no longer available to steer.");
      const [queued] = state.queue.followUp.splice(index, 1);
      if (!queued) throw new Error("Queued message is no longer available to steer.");
      queued.mode = "steer";
      state.queue.steering.push(queued);
      options.onQueueUpdate?.(cloneQueueState(state.queue));
      return cloneQueueState(state.queue);
    }
  });
  return state;
}

async function drainMockQueue(
  mockQueue: ReturnType<typeof createMockQueueControls>,
  request: RuntimeChatRequest,
  provider: RuntimeProviderConfig,
  options: RuntimeOptions,
  initialContent: string,
  initialUserText: string,
  sessionManager?: SessionManager
): Promise<void> {
  while (mockQueue.queue.steering.length > 0 || mockQueue.queue.followUp.length > 0) {
    const submitted = mockQueue.queue.steering.shift() ?? mockQueue.queue.followUp.shift();
    if (!submitted) continue;
    options.onQueueUpdate?.(cloneQueueState(mockQueue.queue));
    const replyContent = submitted.mode === "steer"
      ? `Steered response complete: ${submitted.content}`
      : `Queued follow-up complete: ${submitted.content}`;
    const liveMessagesPrefix: RuntimeGeneratedMessage[] = [
      {
        role: "assistant",
        content: initialContent,
        timeline: mockTimeline(initialContent, initialUserText, request.toolsEnabled ?? true, request.webSearchContext ?? [], {
          modelId: provider.modelId,
          reasoningEffort: request.reasoningEffort
        })
      },
      ...mockQueue.generatedMessages,
      {
        role: "user",
        content: submitted.content,
        attachments: submitted.attachments
      }
    ];
    // Mirror the Pi runtime: surface the delivered steer/follow-up user turn the
    // instant it is accepted, paired with an empty assistant turn, before any reply token streams.
    options.onUpdate?.({
      content: "",
      timeline: [],
      liveMessages: [...liveMessagesPrefix, { role: "assistant", content: "", timeline: [] }]
    });
    await streamMockReply(replyContent, submitted.content, request.toolsEnabled ?? true, request.webSearchContext ?? [], {
      modelId: provider.modelId,
      reasoningEffort: request.reasoningEffort,
      ...options,
      liveMessagesPrefix
    });
    const userEntryId = appendMockUser(sessionManager, submitted.content);
    mockQueue.generatedMessages.push({
      role: "user",
      content: submitted.content,
      attachments: submitted.attachments,
      ...(userEntryId ? { sessionEntryId: userEntryId } : {})
    });
    const assistantEntryId = appendMockAssistant(sessionManager, provider, replyContent);
    mockQueue.generatedMessages.push({
      role: "assistant",
      content: replyContent,
      timeline: mockTimeline(replyContent, submitted.content, request.toolsEnabled ?? true, request.webSearchContext ?? [], {
        modelId: provider.modelId,
        reasoningEffort: request.reasoningEffort
      }),
      ...(assistantEntryId ? { sessionEntryId: assistantEntryId } : {})
    });
  }
  options.onQueueUpdate?.(emptyQueueState());
}

function emptyQueueState(): ChatQueueState {
  return { followUp: [], steering: [] };
}

function cloneQueueState(queue: ChatQueueState): ChatQueueState {
  return {
    followUp: queue.followUp.map((item) => ({ ...item, attachments: item.attachments ? [...item.attachments] : undefined })),
    steering: queue.steering.map((item) => ({ ...item, attachments: item.attachments ? [...item.attachments] : undefined }))
  };
}

function findQueuedMessage(bucket: ChatQueueState["followUp"], id: string) {
  return bucket.find((item) => item.id === id);
}

function removeQueuedMessage(bucket: ChatQueueState["followUp"], id: string): boolean {
  const index = bucket.findIndex((item) => item.id === id);
  if (index < 0) return false;
  bucket.splice(index, 1);
  return true;
}

function normalizeEmptyAssistantResult(
  result: { content: string; timeline: ChatTimelineItem[] },
  provider: RuntimeProviderConfig,
  reasoningEffort: RuntimeChatRequest["reasoningEffort"]
): { content: string; timeline: ChatTimelineItem[] } {
  if (result.content.trim() || hasVisibleTimelineActivity(result.timeline)) return result;
  const content = emptyAssistantResultNotice(provider, reasoningEffort);
  return {
    content,
    timeline: [
      {
        id: "empty-result-notice",
        kind: "assistant_text",
        text: content
      },
      ...result.timeline
    ]
  };
}

function hasVisibleTimelineActivity(timeline: ChatTimelineItem[]): boolean {
  return timeline.some((item) => {
    if (item.kind === "assistant_text" || item.kind === "thinking") return item.text.trim().length > 0;
    if (item.kind === "tool_call" || item.kind === "tool_result") return true;
    if (item.kind !== "system") return false;
    if (item.title === "Model" || item.title === "Thinking level" || item.customType) return false;
    return item.title.trim().length > 0 || item.text.trim().length > 0;
  });
}

function emptyAssistantResultNotice(provider: RuntimeProviderConfig, reasoningEffort: RuntimeChatRequest["reasoningEffort"]): string {
  const retryHint = reasoningEffort && reasoningEffort !== "off"
    ? " You can continue, retry with Reasoning set to off or low, or choose another model."
    : " Retry the request or choose another model.";
  return `${provider.providerName} completed without final assistant text or visible activity for ${provider.modelId}.${retryHint}`;
}

type MockTimelineMeta = {
  modelId?: string;
  reasoningEffort?: string;
  complete?: boolean;
  thinkingProgress?: number;
};

async function streamMockReply(
  content: string,
  lastUserText: string,
  toolsEnabled: boolean,
  webSearchContext: WebSearchResult[],
  options: RuntimeOptions & MockTimelineMeta & { liveMessagesPrefix?: RuntimeGeneratedMessage[] }
): Promise<void> {
  if (!options.onUpdate) return;
  const chunkCount = content.length > 60 ? 8 : 4;
  const lowerUserText = lastUserText.toLowerCase();
  const chunkDelayMs = lowerUserText.includes("queue base") ? 3500 : lowerUserText.includes("slow timeline") ? 1000 : 35;
  for (let index = 1; index <= chunkCount; index += 1) {
    throwIfAborted(options.signal);
    const text = content.slice(0, Math.ceil((content.length * index) / chunkCount));
    const timeline = mockTimeline(text, lastUserText, toolsEnabled, webSearchContext, {
      ...options,
      complete: index === chunkCount,
      thinkingProgress: index / chunkCount
    });
    options.onUpdate({
      content: text,
      timeline,
      liveMessages: [
        ...(options.liveMessagesPrefix ?? []),
        { role: "assistant", content: text, timeline }
      ]
    });
    await abortableDelay(chunkDelayMs, options.signal);
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertSupportedAttachments(
  messages: ChatSendRequest["messages"],
  attachments: NonNullable<ChatSendRequest["attachments"]>,
  content: string,
  provider: RuntimeProviderConfig
): void {
  const hasImage = countModelVisibleImages(messages, attachments, content) > 0;
  if (hasImage && !provider.capabilities?.vision) {
    throw new Error(`${provider.modelId} does not support image input. Select a vision-capable model before sending images.`);
  }
}

function countModelVisibleImages(
  messages: ChatSendRequest["messages"],
  attachments: NonNullable<ChatSendRequest["attachments"]>,
  content: string
): number {
  const history = historyBeforeCurrentPrompt(messages, content, attachments);
  return attachments.filter((item) => item.kind === "file" && item.isImage).length
    + history.flatMap((message) => message.attachments ?? []).filter((item) => item.kind === "file" && item.isImage).length;
}

function buildAssemblyTaxonomy(input: {
  provider: RuntimeProviderConfig;
  systemPrompt: string;
  messages: ChatSendRequest["messages"];
  content: string;
  attachments: NonNullable<ChatSendRequest["attachments"]>;
  reason: NonNullable<ContextTaxonomy["assemblyReason"]>;
}): ContextTaxonomy {
  const history = historyBeforeCurrentPrompt(input.messages, input.content, input.attachments);
  const items = [
    taxonomyItem({
      order: 1,
      role: "system",
      source: "jasmine.systemPrompt",
      label: "Jasmine system prompt",
      kind: "system_prompt",
      confidence: 0.9,
      payloadPath: "jasmine.systemPrompt",
      text: input.systemPrompt
    }),
    ...history.map((message, index) => taxonomyItem({
      order: index + 2,
      role: message.role,
      source: "session.history",
      label: `History ${index + 1}`,
      kind: assemblyMessageKind(message.role),
      confidence: 0.75,
      payloadPath: `session.history[${index}]`,
      text: message.content
    })),
    taxonomyItem({
      order: history.length + 2,
      role: "user",
      source: "current.prompt",
      label: "Current user prompt",
      kind: "current_user_prompt",
      confidence: 0.9,
      payloadPath: "current.prompt",
      text: promptTextForTaxonomy(input.content, input.attachments)
    })
  ];
  return {
    capturedAt: new Date().toISOString(),
    provider: input.provider.providerName,
    model: input.provider.modelId,
    source: "jasmine-assembly",
    assemblyReason: input.reason,
    payloadSchemaVersion: CONTEXT_TAXONOMY_SCHEMA_VERSION,
    items
  };
}

function groupProviderRequestCaptures(captures: ContextTaxonomy[]): ContextTaxonomy[] {
  const groups: Array<{ key: string; taskIndex: number; captures: ContextTaxonomy[] }> = [];
  for (const capture of captures) {
    const current = capture.items.find((item) => item.kind === "current_user_prompt");
    const key = `${current?.payloadPath ?? "unknown"}\n${current?.text ?? current?.preview ?? ""}`;
    const latest = groups.at(-1);
    if (latest?.key === key) latest.captures.push(capture);
    else groups.push({ key, taskIndex: groups.length + 1, captures: [capture] });
  }
  return groups.flatMap((group) => group.captures.map((capture, index) => ({
    ...capture,
    providerRequest: {
      index: index + 1,
      count: group.captures.length,
      taskIndex: group.taskIndex,
      policy: "task-capture" as const
    }
  })));
}

function historyBeforeCurrentPrompt(messages: ChatSendRequest["messages"], content: string, attachments: NonNullable<ChatSendRequest["attachments"]>): ChatSendRequest["messages"] {
  const last = messages.at(-1);
  if (last?.role === "user" && last.content.trim() === content.trim() && sameAttachments(last.attachments ?? [], attachments)) {
    return messages.slice(0, -1);
  }
  return messages;
}

function sameAttachments(first: NonNullable<ChatSendRequest["attachments"]>, second: NonNullable<ChatSendRequest["attachments"]>): boolean {
  if (first.length !== second.length) return false;
  return first.every((item, index) => {
    const other = second[index];
    return Boolean(other)
      && item.kind === other.kind
      && item.path === other.path
      && item.isImage === other.isImage
      && item.mediaType === other.mediaType;
  });
}

function assemblyMessageKind(role: string): ContextTaxonomyKind {
  return role === "system" ? "system_prompt" : "conversation_history";
}

function mockStructuredTaxonomy(provider: RuntimeProviderConfig, includeUnclassified = false): ContextTaxonomy {
  const systemText = [
    "You are Jasmine, a calm local-first personal AI assistant.",
    "<project_context>",
    "# Jasmine Agent Instructions",
    "Read AGENTS.md before material repository changes.",
    "</project_context>",
    "<skill_instructions>",
    "- ui-ux-product-harness: Build or run a productized UI/UX self-testing harness.",
    "- technical-writer: Tightens technical explanations.",
    "</skill_instructions>"
  ].join("\n");
  const toolDefinition = {
    type: "function",
    function: {
      name: "read",
      description: "Read file contents.",
      parameters: { type: "object", properties: { path: { type: "string" } } }
    }
  };
  const payload = {
    model: provider.modelId,
    messages: [
      { role: "system", content: systemText },
      { role: "user", content: "show structured taxonomy" }
    ],
    stream: true,
    ...(includeUnclassified ? { future_context_envelope: { checkpoint: 3, note: "classifier coverage fixture" } } : {}),
    tools: [toolDefinition]
  };
  const taxonomy = withContextCacheMetrics(providerPayloadToContextTaxonomy(payload, {
    provider: provider.providerName,
    model: provider.modelId
  }), {
    input: 137,
    output: 18,
    cacheRead: 4096,
    cacheWrite: 0,
    totalTokens: 4251
  });
  return {
    ...taxonomy,
    reasoningValidation: {
      status: "not_applicable",
      policyId: "deepseek-tool-interval-v1",
      policyVersion: 1,
      policySource: "https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/",
      summary: "No reasoning block is required by this policy for the captured request.",
      requiredCount: 0,
      sentCount: 0,
      blocks: []
    }
  };
}

function promptTextForTaxonomy(content: string, attachments: NonNullable<ChatSendRequest["attachments"]>): string {
  const lines = [content.trim() || "[Attachment-only message]"];
  if (attachments.length > 0) {
    lines.push("", "Attachments:", ...attachments.map((item) => `- ${item.kind}: ${item.path}`));
  }
  return lines.join("\n");
}

function mockContent(lastUserText: string, imageCount: number, toolsEnabled: boolean, memoryContext: string[], skillContext: RuntimeSkillManifest[], inlineSkillNames: string[], webSearchContext: WebSearchResult[]): string {
  if (imageCount > 0) return `Mock reply received ${imageCount} image attachment.`;
  if (lastUserText.toLowerCase().includes("tools state")) return toolsEnabled ? "Pi tools are on." : "Pi tools are off.";
  const explicitNames = inlineSkillNames.length > 0 ? inlineSkillNames : explicitSkillNames(lastUserText);
  if (explicitNames.length > 0 && lastUserText.toLowerCase().includes("skill")) {
    return `Inline skill reply using ${explicitNames.join(", ")}.`;
  }
  if (skillContext.length > 0 && lastUserText.toLowerCase().includes("skill")) {
    return `Skill-aware reply using ${skillContext.map((skill) => skill.name).join(", ")}.`;
  }
  if (webSearchContext.length > 0) {
    return `Web search used: ${webSearchContext[0].title} (${webSearchContext[0].url}).`;
  }
  if (memoryContext.length > 0 && lastUserText.toLowerCase().includes("memory")) {
    return `Memory-aware reply: ${memoryContext[0]}`;
  }
  if (lastUserText.toLowerCase().includes("long answer")) {
    return Array.from({ length: 42 }, (_item, index) => `Long answer paragraph ${index + 1}: Jasmine keeps the message scrollable while the composer remains pinned.`).join("\n\n");
  }
  if (lastUserText.toLowerCase().includes("markdown")) {
    return [
      "### Markdown sample",
      "",
      "This is a **bold** answer with [a link](https://example.com) and `inline code`.",
      "",
      "- First point",
      "- Second point with `inline code`",
      "",
      "| Item | Status |",
      "| --- | --- |",
      "| Table support | ok |",
      "| Link support | ok |",
      "",
      "```ts",
      "const ok = true;",
      "const longLine = \"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\";",
      "```",
      "",
      "```ts twoslash title=\"types.ts\"",
      "const user = { name: \"Jasmine\", count: 1 };",
      "user.name;",
      "//   ^?",
      "```"
    ].join("\n");
  }
  if (lastUserText.toLowerCase().includes("slow response")) return "Slow response complete.";
  if (lastUserText.toLowerCase().includes("second branch")) return "Second branch reply.";
  if (lastUserText.toLowerCase().includes("first branch")) return "First branch reply.";
  return "Mock reply from Jasmine.";
}

function explicitSkillNames(text: string): string[] {
  return Array.from(text.matchAll(/<skill name="([^"]+)">/g)).map((match) => match[1]);
}

function mockTimeline(
  content: string,
  lastUserText: string,
  toolsEnabled: boolean,
  webSearchContext: WebSearchResult[],
  meta: MockTimelineMeta = {}
): ChatTimelineItem[] {
  const items: ChatTimelineItem[] = [];
  if (lastUserText.toLowerCase().includes("timeline")) {
    if (meta.modelId) {
      items.push({
        id: "mock-model",
        kind: "system",
        title: "Model",
        text: `mock/${meta.modelId}`
      });
    }
    if (meta.reasoningEffort) {
      items.push({
        id: "mock-thinking-level",
        kind: "system",
        title: "Thinking level",
        text: meta.reasoningEffort
      });
    }
  }
  if (lastUserText.toLowerCase().includes("timeline") || webSearchContext.length > 0) {
    items.push({
      id: "mock-thinking",
      kind: "thinking",
      text: partialText(thinkingMockText(lastUserText, webSearchContext), meta.thinkingProgress ?? 1)
    });
  }
  if (lastUserText.toLowerCase().includes("timeline") && toolsEnabled) {
    if (lastUserText.toLowerCase().includes("interleaved tools")) {
      items.push({
        id: "mock-interleaved-read-call",
        kind: "tool_call",
        toolName: "read",
        title: "read",
        argumentsJson: JSON.stringify({ path: "skills/document-analysis/SKILL.md" }, null, 2)
      });
      items.push({
        id: "mock-interleaved-thinking-after-read",
        kind: "thinking",
        text: "Need the script after reading the skill instructions."
      });
      items.push({
        id: "mock-interleaved-bash-call",
        kind: "tool_call",
        toolName: "bash",
        title: "bash",
        argumentsJson: JSON.stringify({ command: "ls -R C:\\workspace\\document-analysis | head" }, null, 2)
      });
      if (meta.complete !== false) {
        items.push({
          id: "mock-interleaved-read-result",
          kind: "tool_result",
          toolName: "read",
          title: "read",
          content: Array.from({ length: 202 }, (_item, index) => `skill line ${index + 1}`).join("\n"),
          isError: false
        });
        items.push({
          id: "mock-interleaved-thinking-after-result",
          kind: "thinking",
          text: "Now inspect the renderer script."
        });
        items.push({
          id: "mock-interleaved-bash-result",
          kind: "tool_result",
          toolName: "bash",
          title: "bash",
          content: Array.from({ length: 15 }, (_item, index) => `file ${index + 1}`).join("\n"),
          isError: false
        });
      }
    } else if (lastUserText.toLowerCase().includes("stoppable tool")) {
      items.push({
        id: "mock-stoppable-bash-call",
        kind: "tool_call",
        toolName: "bash",
        title: "bash",
        argumentsJson: JSON.stringify({ command: "find / -name node -type f 2>/dev/null | head -20" }, null, 2)
      });
      if (meta.complete !== false && content.includes("Jasmine.")) {
        items.push({
          id: "mock-stoppable-bash-result",
          kind: "tool_result",
          toolName: "bash",
          title: "bash",
          content: "node\nCommand exited with code 0",
          isError: false
        });
      }
    } else if (lastUserText.toLowerCase().includes("write")) {
      items.push({
        id: "mock-write-call",
        kind: "tool_call",
        toolName: "write",
        title: "write",
        argumentsJson: JSON.stringify({ path: "src/example.ts", content: "export function hello() {\n  return 'hello';\n}\n" }, null, 2)
      });
      if (meta.complete !== false) {
        items.push({
          id: "mock-write-result",
          kind: "tool_result",
          toolName: "write",
          title: "write",
          content: "Successfully wrote 44 bytes to\nsrc/example.ts",
          isError: false
        });
      }
    } else if (lastUserText.toLowerCase().includes("edit")) {
      items.push({
        id: "mock-edit-call",
        kind: "tool_call",
        toolName: "edit",
        title: "edit",
        argumentsJson: JSON.stringify({ path: "src/example.ts", oldText: "return 'hello';", newText: "return 'jasmine';" }, null, 2)
      });
      if (meta.complete !== false) {
        items.push({
          id: "mock-edit-result",
          kind: "tool_result",
          toolName: "edit",
          title: "edit",
          content: "--- a/src/example.ts\n+++ b/src/example.ts\n-  return 'hello';\n+  return 'jasmine';",
          isError: false
        });
      }
    } else if (lastUserText.toLowerCase().includes("bash error")) {
      items.push({
        id: "mock-bash-call",
        kind: "tool_call",
        toolName: "bash",
        title: "bash",
        argumentsJson: JSON.stringify({ command: "taskkill /F /PID 24552" }, null, 2)
      });
      if (meta.complete !== false) {
        items.push({
        id: "mock-bash-result",
        kind: "tool_result",
        toolName: "bash",
        title: "bash",
        content: "����: �޷���ֹ PID 24552\n\nCommand exited with code 1",
        isError: true
        });
      }
    } else if (lastUserText.toLowerCase().includes("bash")) {
      items.push({
        id: "mock-bash-call",
        kind: "tool_call",
        toolName: "bash",
        title: "bash",
        argumentsJson: JSON.stringify({ command: "ls src/renderer/components/chat" }, null, 2)
      });
      if (meta.complete !== false) {
        items.push({
          id: "mock-bash-result",
          kind: "tool_result",
          toolName: "bash",
          title: "bash",
          content: "MessageTimeline.tsx\nMessageView.tsx\nMarkdownMessage.tsx",
          isError: false
        });
      }
    } else {
      items.push({
        id: "mock-tool-call",
        kind: "tool_call",
        toolName: "read",
        title: "Read project context",
        argumentsJson: JSON.stringify({ path: "AGENTS.md" }, null, 2)
      });
      if (meta.complete !== false) {
        items.push({
          id: "mock-tool-result",
          kind: "tool_result",
          toolName: "read",
          title: "Read project context",
          content: "Project instructions loaded.",
          isError: false
        });
      }
    }
  }
  items.push({
    id: "mock-output",
    kind: "assistant_text",
    text: content
  });
  return items;
}

function thinkingMockText(lastUserText: string, webSearchContext: WebSearchResult[]): string {
  if (webSearchContext.length > 0) return "Need to incorporate the current web result before answering.";
  if (lastUserText.toLowerCase().includes("rich thinking")) {
    return [
      "I need to inspect why the rendered reasoning content appears centered instead of reading as one left-aligned flow.",
      "",
      "Looking at the response, the user-visible issue combines paragraphs and a list:",
      "",
      "- fenced `yaml` blocks should stay in the same column",
      "- fenced `markdown` blocks should stay in the same column",
      "- fenced `python` blocks should stay in the same column",
      "",
      "The layout should keep all thinking markdown blocks aligned to the same left edge."
    ].join("\n");
  }
  return "Need to inspect the requested chronological behavior and answer with the final result.";
}

function partialText(text: string, progress: number): string {
  const normalized = Math.max(0, Math.min(1, progress));
  if (normalized >= 1) return text;
  return text.slice(0, Math.max(1, Math.ceil(text.length * normalized)));
}

export type PiShellRuntime = {
  shellPath?: string;
  kind: "default-bash" | "bash" | "powershell" | "unsupported";
  configuredPath?: string;
  fallbackReason?: "wsl-bash-launcher";
};

export function resolvePiShellRuntime(terminalShellPath?: string): PiShellRuntime {
  const configuredPath = terminalShellPath?.trim();
  if (!configuredPath) return { kind: "default-bash" };
  if (!existsSync(configuredPath)) return { kind: "unsupported", configuredPath };
  if (isWindowsBashLauncherPath(configuredPath)) {
    const gitBashPath = findGitBashPath();
    return gitBashPath
      ? { kind: "bash", shellPath: gitBashPath, configuredPath, fallbackReason: "wsl-bash-launcher" }
      : { kind: "unsupported", configuredPath, fallbackReason: "wsl-bash-launcher" };
  }
  const basename = path.basename(configuredPath).toLowerCase();
  if (basename === "bash.exe" || basename === "bash") return { kind: "bash", shellPath: configuredPath, configuredPath };
  if (basename === "powershell.exe" || basename === "powershell" || basename === "pwsh.exe" || basename === "pwsh") {
    return { kind: "powershell", shellPath: configuredPath, configuredPath };
  }
  return { kind: "unsupported", configuredPath };
}

export function buildSystemPrompt(
  memoryContext: string[],
  _skillContext: RuntimeSkillManifest[],
  webSearchContext: WebSearchResult[],
  _toolsEnabled = true,
  options: { piShell?: PiShellRuntime; cwd?: string } = {}
): string {
  const base = "You are Jasmine, a calm local-first personal AI assistant. Be concise, practical, and answer in the user's language.";
  const sections = [base, ...environmentGuidance(options.piShell)];
  if (options.cwd) {
    sections.push("", `Current working directory: ${options.cwd}`);
  }
  if (memoryContext.length > 0) {
    sections.push(
      "",
      "Relevant local memories, explicitly saved by the user:",
      ...memoryContext.map((memory, index) => `${index + 1}. ${memory}`)
    );
  }
  if (webSearchContext.length > 0) {
    sections.push(
      "",
      "Web search results fetched for this request. Use them only when relevant, cite source URLs inline, and say when the results are insufficient:",
      ...webSearchContext.map((result, index) => `${index + 1}. ${result.title}\nURL: ${result.url}\nSnippet: ${result.snippet}`)
    );
  }
  return sections.join("\n");
}

function environmentGuidance(piShell: PiShellRuntime = { kind: "default-bash" }): string[] {
  if (process.platform !== "win32") return [];
  if (piShell.kind === "powershell") {
    return [
      "",
      "Runtime environment guidance:",
      `- The Pi tool named \`bash\` is configured to run through the app Terminal shell: ${piShell.shellPath}. Write commands for PowerShell, even though the tool label remains \`bash\`.`,
      "- Prefer Windows absolute paths such as `C:\\Users\\...` when referencing user files. Do not assume Unix paths like `/tmp` exist; use `$env:TEMP` or another verified Windows path.",
      "- Do not assume `python3` or `py` exists. Probe `Get-Command python`, `python --version`, and `python -c \"print('ok')\"` before using Python packages; if a command exits with only a code and no output, treat it as a shell/PATH issue and try an explicit Windows executable path."
    ];
  }
  if (piShell.kind === "bash") {
    if (piShell.fallbackReason === "wsl-bash-launcher" && piShell.configuredPath && piShell.shellPath) {
      return [
        "",
        "Runtime environment guidance:",
        `- The configured app Terminal shell is Windows' WSL bash launcher (${piShell.configuredPath}), so it is not passed to Pi. The Pi tool named \`bash\` uses Git Bash instead: ${piShell.shellPath}. Write commands for Git Bash.`,
        "- Prefer Windows absolute paths such as `C:\\Users\\...` when referencing user files. In Git Bash, Windows drives are available as `/c/...`; do not use WSL-only paths like `/mnt/c/...` unless you have verified them in this shell.",
        "- Do not assume `python3` or `py` exists. Probe `command -v python`, `python --version`, and `python -c \"print('ok')\"` before using Python packages; if a command exits with only a code and no output, treat it as a shell/PATH issue and try an explicit Windows executable path."
      ];
    }
    return [
      "",
      "Runtime environment guidance:",
      `- The Pi tool named \`bash\` is configured to run through the app Terminal shell: ${piShell.shellPath}. Write commands for bash/Git Bash.`,
      "- Prefer verified Windows absolute paths when referencing user files. Do not assume Unix paths like `/tmp` exist; use `%TEMP%` or `$TEMP` after verifying.",
      "- Do not assume `python3` or `py` exists. Probe `command -v python`, `python --version`, and `python -c \"print('ok')\"` before using Python packages; if a command exits with only a code and no output, treat it as a shell/PATH issue and try an explicit Windows executable path."
    ];
  }
  return [
    "",
    "Runtime environment guidance:",
    piShell.kind === "unsupported"
      ? "- The app Terminal shell is not passed to Pi because it is not compatible with Pi's `shellPath` execution contract. The `bash` tool falls back to Git Bash or another bash.exe on Windows."
      : "- The `bash` tool runs through Git Bash or another bash.exe on Windows, not PowerShell and not the app's interactive Terminal setting.",
    "- Prefer verified Windows absolute paths when referencing user files. Do not assume Unix paths like `/tmp` exist; use `%TEMP%` or `$TEMP` after verifying.",
    "- Do not assume `python3` or `py` exists. Probe `command -v python`, `python --version`, and `python -c \"print('ok')\"` before using Python packages; if a command exits with only a code and no output, treat it as a shell/PATH issue and try an explicit Windows executable path."
  ];
}
