import { readFile } from "node:fs/promises";
import { AuthStorage, createAgentSessionFromServices, createAgentSessionServices, defineTool, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, ImageContent, Message, Model, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AskUserQuestionOption, AskUserQuestionPrompt, AskUserQuestionResponse, ChatQueueMode, ChatQueueState, ChatQueuedMessage, ChatSendRequest, ChatTimelineItem, ContextTaxonomy, PickedPath, ReasoningEffort, RemoteConnectionRecord, WebSearchResult } from "../../../shared/ipc.js";
import type { RuntimeProviderConfig } from "../runtime.js";
import type { RuntimeGeneratedMessage, RuntimeQueueControls } from "../runtime.js";
import type { RuntimeSkillManifest } from "../../services/skillManifests.js";
import { createSshCodingTools } from "../tools/sshCodingTools.js";
import { createContextCaptureExtension } from "../extensions/contextCapture/index.js";
import { remoteLabel, testRemoteConnection } from "../../services/remoteConnections.js";
import { abortError } from "../../utils/abort.js";
import { mergeWebSearchResultsInto } from "../../utils/webSearchResults.js";

type PiCodingAgentChatInput = {
  provider: RuntimeProviderConfig;
  messages: ChatSendRequest["messages"];
  content: string;
  attachments: PickedPath[];
  systemPrompt: string;
  cwd?: string;
  agentDir?: string;
  toolsEnabled: boolean;
  reasoningEffort?: ReasoningEffort;
  webSearchTool?: {
    enabled: boolean;
    provider: "pi-web-access" | "duckduckgo";
    search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]>;
  };
  askUserQuestion?: (prompt: Omit<AskUserQuestionPrompt, "id">, signal?: AbortSignal) => Promise<AskUserQuestionResponse>;
  promptTemplatePaths?: string[];
  skillContext?: RuntimeSkillManifest[];
  packageSkillPaths?: string[];
  packageExtensionPaths?: string[];
  remoteConnection?: RemoteConnectionRecord | null;
  shellPath?: string;
  signal?: AbortSignal;
  onUpdate?(update: { content: string; timeline: ChatTimelineItem[]; liveMessages?: RuntimeGeneratedMessage[] }): void;
  onQueueReady?(controls: RuntimeQueueControls): void;
  onQueueUpdate?(queue: ChatQueueState): void;
  onContextTaxonomy?(taxonomy: ContextTaxonomy): void;
};

export type PiCodingAgentChatResult = {
  content: string;
  timeline: ChatTimelineItem[];
  webSearchUsed: WebSearchResult[];
  generatedMessages?: RuntimeGeneratedMessage[];
  liveMessages?: RuntimeGeneratedMessage[];
};

export async function runPiCodingAgentChat(input: PiCodingAgentChatInput): Promise<PiCodingAgentChatResult> {
  const historyMessages = historyBeforePrompt(input.messages, input.content, input.attachments);
  const imageAttachments = input.attachments.filter((item) => item.kind === "file" && item.isImage);
  const historicalImageAttachments = historyMessages.flatMap((message) => message.attachments ?? []).filter((item) => item.kind === "file" && item.isImage);
  if ((imageAttachments.length > 0 || historicalImageAttachments.length > 0) && !input.provider.capabilities?.vision) {
    throw new Error(`${input.provider.modelId} does not support image input in this conversation. Select a vision-capable model before sending images.`);
  }

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(input.provider.providerName, input.provider.apiKey);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(input.provider.providerName, {
    name: input.provider.providerName,
    baseUrl: input.provider.baseUrl,
    apiKey: input.provider.apiKey,
    models: [toPiModel(input.provider)]
  });

  const model = modelRegistry.find(input.provider.providerName, input.provider.modelId);
  if (!model) {
    throw new Error(`${input.provider.modelId} is not registered for ${input.provider.providerName}.`);
  }

  const cwd = input.cwd?.trim() || process.cwd();
  const sessionManager = SessionManager.inMemory(cwd);
  for (const message of historyMessages) {
    await appendHistoricalMessage(sessionManager, message, input.provider);
    restoreTimelineCustomEntries(sessionManager, message.timeline);
  }
  const previousEntryCount = sessionManager.getEntries().length;
  const webSearchUsed: WebSearchResult[] = [];
  const webSearchEnabled = Boolean(input.webSearchTool?.enabled);
  const remote = input.remoteConnection ? await resolveRemoteConnection(input.remoteConnection) : null;
  const customTools = webSearchEnabled && input.webSearchTool?.provider === "duckduckgo"
    ? [
        createWebSearchTool(async (query, signal) => {
          const results = await input.webSearchTool?.search(query, signal) ?? [];
          mergeWebSearchResultsInto(webSearchUsed, results);
          return results;
        })
      ]
    : [];
  if (input.askUserQuestion) {
    customTools.push(createAskUserQuestionTool(input.askUserQuestion));
  }
  if (remote) {
    customTools.push(...createSshCodingTools({
      connection: remote.connection,
      localCwd: cwd,
      remoteCwd: remote.remoteCwd
    }));
  }
  const additionalSkillPaths = selectedSkillPaths(input.skillContext, input.packageSkillPaths);
  const currentPromptText = promptText(input.content, input.attachments);
  const currentPromptAnchorText = promptAnchorText(input.content, input.attachments);

  const resourceLoaderOptions = {
    systemPrompt: remote ? remoteSystemPrompt(input.systemPrompt, cwd, remote.connection, remote.remoteCwd) : input.systemPrompt,
    noSkills: true,
    ...(input.packageExtensionPaths?.length ? { additionalExtensionPaths: Array.from(new Set(input.packageExtensionPaths)) } : {}),
    ...(additionalSkillPaths.length ? { additionalSkillPaths } : {}),
    ...(input.promptTemplatePaths?.length ? { additionalPromptTemplatePaths: input.promptTemplatePaths } : {}),
    ...(input.onContextTaxonomy ? { extensionFactories: [createContextCaptureExtension({
      provider: input.provider.providerName,
      model: input.provider.modelId,
      currentUserPromptText: currentPromptAnchorText,
      onCapture: input.onContextTaxonomy
    })] } : {})
  };
  const services = await createAgentSessionServices({
    cwd,
    ...(input.agentDir ? { agentDir: input.agentDir } : {}),
    authStorage,
    modelRegistry,
    resourceLoaderOptions
  });
  if (input.shellPath) {
    services.settingsManager.applyOverrides({ shellPath: input.shellPath });
  }
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    customTools
  });
  if (input.reasoningEffort) {
    session.setThinkingLevel(input.reasoningEffort);
  }

  const trackedQueue = createTrackedQueue(input.onQueueUpdate);
  const steeringTasks = new Set<Promise<void>>();
  let latestUpdate: PiCodingAgentChatResult = { content: "", timeline: [], webSearchUsed };
  // The assistant message that is currently streaming (thinking / text / tool
  // starts) but has not yet been committed to the session timeline. It is folded
  // into the trailing assistant turn so its tokens render incrementally with
  // stable item ids, instead of only appearing once the turn is committed.
  let inFlightTimeline: ChatTimelineItem[] | null = null;
  // Queued/steer prompts that have been delivered to Pi but whose user entry has
  // not yet appeared in the session timeline. They are appended to the live
  // snapshot so the bubble shows the instant a steer is accepted, not one token later.
  const pendingDeliveredMessages = new Map<string, RuntimeGeneratedMessage>();
  let inFlightFollowsDeliveredId: string | null = null;
  // Single authoritative live snapshot: committed session entries, plus the one
  // in-flight streaming assistant turn, plus any delivered-but-uncommitted user
  // turns. Always derived from the same source so the renderer never sees two
  // competing snapshots toggling against each other.
  const computeLiveMessages = (): RuntimeGeneratedMessage[] => {
    const messages = sessionEntriesToMessages(
      sessionManager.getEntries().slice(previousEntryCount),
      "",
      currentPromptText,
      trackedQueue.deliveredMessages()
    );
    const pendingMessages: Array<[string, RuntimeGeneratedMessage]> = [];
    for (const [id, pending] of pendingDeliveredMessages) {
      const present = messages.some((message) => message.role === "user" && message.content.trim() === pending.content.trim());
      if (present) pendingDeliveredMessages.delete(id);
      else pendingMessages.push([id, pending]);
    }
    const activePendingIndex = inFlightFollowsDeliveredId
      ? pendingMessages.findIndex(([id]) => id === inFlightFollowsDeliveredId)
      : -1;
    if (activePendingIndex >= 0) {
      const [activePending] = pendingMessages.splice(activePendingIndex, 1);
      messages.push(activePending[1]);
    }
    if (inFlightTimeline && inFlightTimeline.length > 0) {
      foldInFlightTimeline(messages, inFlightTimeline);
    }
    for (const [_id, pending] of pendingMessages) {
      messages.push(pending);
    }
    return messages;
  };
  const emitLiveUpdate = () => {
    if (!input.onUpdate) return;
    const liveMessages = computeLiveMessages();
    const trailingAssistant = lastAssistantMessage(liveMessages);
    latestUpdate = {
      content: trailingAssistant?.content ?? "",
      timeline: trailingAssistant?.timeline ?? [],
      webSearchUsed: [],
      liveMessages
    };
    input.onUpdate(latestUpdate);
  };
  const sendQueuedMessage = async (queued: TrackedQueuedMessage, mode: ChatQueueMode) => {
    const queuedImages = queued.attachments?.filter((item) => item.kind === "file" && item.isImage) ?? [];
    if (queuedImages.length > 0 && !input.provider.capabilities?.vision) {
      throw new Error(`${input.provider.modelId} does not support image input in this conversation. Select a vision-capable model before sending images.`);
    }
    trackedQueue.markDelivering(queued.id);
    pendingDeliveredMessages.set(queued.id, { role: "user", content: queued.content, attachments: queued.attachments });
    emitLiveUpdate();
    inFlightFollowsDeliveredId = queued.id;
    await session.prompt(queued.piText, {
      images: await imageContent(queuedImages),
      streamingBehavior: mode
    });
    if (inFlightFollowsDeliveredId === queued.id) {
      inFlightFollowsDeliveredId = null;
      inFlightTimeline = null;
    }
    trackedQueue.deliver(queued.id);
  };
  const startSteeringTask = (queued: TrackedQueuedMessage) => {
    let task: Promise<void>;
    task = sendQueuedMessage(queued, "steer")
      .catch((error) => {
        trackedQueue.remove(queued.id);
        throw error;
      })
      .finally(() => {
        steeringTasks.delete(task);
      });
    steeringTasks.add(task);
    return task;
  };
  const queueControls: RuntimeQueueControls = {
    queueMessage: async (message) => {
      const queued = trackedQueue.add(message.mode, message.content, message.attachments);
      if (message.mode === "steer") void startSteeringTask(queued);
      return trackedQueue.publicState();
    },
    updateMessage: async (message) => {
      trackedQueue.update(message.id, message.content, message.attachments);
      return trackedQueue.publicState();
    },
    deleteMessage: async (id) => {
      trackedQueue.deletePending(id);
      return trackedQueue.publicState();
    },
    steerMessage: async (id) => {
      const queued = trackedQueue.steer(id);
      void startSteeringTask(queued);
      return trackedQueue.publicState();
    }
  };

  const unsubscribe = (input.onUpdate || input.onQueueUpdate)
    ? session.subscribe((event) => {
        if (isQueueUpdateEvent(event)) return;
        const eventType = streamEventType(event);
        if (eventType !== "message_update" && eventType !== "message_end") return;
        const update = eventToLiveUpdate(event);
        if (update && update.timeline.length > 0) inFlightTimeline = update.timeline;
        emitLiveUpdate();
      })
    : undefined;
  let rejectAbort: ((error: Error) => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abortSession = () => {
    void session.abort().catch(() => undefined);
    rejectAbort?.(abortError());
  };
  if (input.signal?.aborted) abortSession();
  input.signal?.addEventListener("abort", abortSession, { once: true });

  try {
    const initialPrompt = session.prompt(currentPromptText, {
      images: await imageContent(imageAttachments)
    });
    input.onQueueReady?.(queueControls);
    await Promise.race([
      initialPrompt,
      abortPromise
    ]);
    if (!inFlightFollowsDeliveredId) inFlightTimeline = null;
    await Promise.allSettled(Array.from(steeringTasks));
    while (trackedQueue.hasPendingFollowUps()) {
      const queued = trackedQueue.shiftNextFollowUp();
      if (!queued) break;
      await sendQueuedMessage(queued, "followUp");
    }
    const newEntries = sessionManager.getEntries().slice(previousEntryCount);
    const timeline = sessionEntriesToTimeline(newEntries, latestUpdate.content);
    const content = (assistantTextFromTimeline(timeline) || latestUpdate.content).trim();
    const generatedMessages = sessionEntriesToMessages(newEntries, latestUpdate.content, currentPromptText, trackedQueue.deliveredMessages());
    return {
      content,
      timeline,
      webSearchUsed: mergeDerivedWebSearchResults(webSearchUsed, newEntries),
      generatedMessages: generatedMessages.length > 1 ? generatedMessages : undefined
    };
  } catch (error) {
    if (input.signal?.aborted) {
      const content = (latestUpdate.content || assistantTextFromTimeline(latestUpdate.timeline) || "Response stopped.").trim();
      const timeline = liveTimelineFromSession(sessionManager, previousEntryCount, content, [], latestUpdate.timeline);
      return {
        content,
        timeline: [
          ...timeline,
          {
            id: "user-abort",
            kind: "system",
            title: "Stopped",
            text: "The response was stopped by the user."
          }
        ],
        webSearchUsed: mergeDerivedWebSearchResults(webSearchUsed, sessionManager.getEntries().slice(previousEntryCount))
      };
    }
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abortSession);
    rejectAbort = null;
    unsubscribe?.();
    session.dispose();
  }
}

function selectedSkillPaths(skillContext: RuntimeSkillManifest[] | undefined, packageSkillPaths: string[] | undefined): string[] {
  return Array.from(new Set([
    ...(skillContext ?? []).map((skill) => skill.skillFilePath),
    ...(packageSkillPaths ?? [])
  ]));
}

type TrackedQueuedMessage = ChatQueuedMessage & {
  piText: string;
};

function createTrackedQueue(onUpdate?: (queue: ChatQueueState) => void) {
  const steering: TrackedQueuedMessage[] = [];
  const followUp: TrackedQueuedMessage[] = [];
  const delivered: TrackedQueuedMessage[] = [];

  const emit = () => {
    onUpdate?.(publicState());
  };

  const publicState = (): ChatQueueState => ({
    steering: steering.map(toPublicQueuedMessage),
    followUp: followUp.map(toPublicQueuedMessage)
  });

  const syncBucket = (bucket: TrackedQueuedMessage[], expectedCount: number) => {
    while (bucket.length > expectedCount) {
      const item = bucket.shift();
      if (item) delivered.push(item);
    }
  };

  return {
    add(mode: ChatQueueMode, content: string, attachments: PickedPath[]): TrackedQueuedMessage {
      const trimmedContent = content.trim();
      const queued: TrackedQueuedMessage = {
        id: `queue-${crypto.randomUUID()}`,
        mode,
        content: trimmedContent,
        attachments,
        createdAt: new Date().toISOString(),
        piText: promptText(trimmedContent, attachments)
      };
      if (mode === "steer") steering.push(queued);
      else followUp.push(queued);
      emit();
      return queued;
    },
    update(id: string, content: string, attachments: PickedPath[]) {
      const item = followUp.find((queued) => queued.id === id);
      if (!item) throw new Error("Queued message is no longer editable.");
      item.content = content.trim();
      item.attachments = attachments;
      item.piText = promptText(item.content, attachments);
      emit();
    },
    deletePending(id: string) {
      if (!removeQueuedMessage(followUp, id)) throw new Error("Queued message is no longer deletable.");
      emit();
    },
    steer(id: string): TrackedQueuedMessage {
      const index = followUp.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Queued message is no longer available to steer.");
      const [queued] = followUp.splice(index, 1);
      if (!queued) throw new Error("Queued message is no longer available to steer.");
      queued.mode = "steer";
      steering.push(queued);
      emit();
      return queued;
    },
    markDelivering(id: string) {
      const item = removeQueuedMessage(steering, id) ?? removeQueuedMessage(followUp, id);
      if (item && !delivered.some((deliveredItem) => deliveredItem.id === item.id)) delivered.push(item);
      if (item) emit();
    },
    remove(id: string) {
      removeQueuedMessage(steering, id);
      removeQueuedMessage(followUp, id);
      removeQueuedMessage(delivered, id);
      emit();
    },
    sync(steeringCount: number, followUpCount: number) {
      syncBucket(steering, steeringCount);
      syncBucket(followUp, followUpCount);
      emit();
    },
    deliver(id: string) {
      const item = removeQueuedMessage(steering, id) ?? removeQueuedMessage(followUp, id);
      if (item && !delivered.some((deliveredItem) => deliveredItem.id === item.id)) delivered.push(item);
      emit();
    },
    hasPendingFollowUps() {
      return followUp.length > 0;
    },
    shiftNextFollowUp(): TrackedQueuedMessage | undefined {
      const item = followUp.shift();
      if (item && !delivered.some((deliveredItem) => deliveredItem.id === item.id)) delivered.push(item);
      emit();
      return item;
    },
    publicState,
    deliveredMessages() {
      return delivered.map((item) => ({ ...item, attachments: item.attachments ? [...item.attachments] : undefined }));
    }
  };
}

function toPublicQueuedMessage(item: TrackedQueuedMessage): ChatQueuedMessage {
  return {
    id: item.id,
    mode: item.mode,
    content: item.content,
    attachments: item.attachments,
    createdAt: item.createdAt
  };
}

function removeQueuedMessage(bucket: TrackedQueuedMessage[], id: string): TrackedQueuedMessage | undefined {
  const index = bucket.findIndex((item) => item.id === id);
  if (index < 0) return undefined;
  const [removed] = bucket.splice(index, 1);
  return removed;
}

async function resolveRemoteConnection(connection: RemoteConnectionRecord): Promise<{ connection: RemoteConnectionRecord; remoteCwd: string }> {
  if (connection.remotePath?.trim()) return { connection, remoteCwd: connection.remotePath.trim() };
  const tested = await testRemoteConnection(connection);
  return {
    connection: { ...connection, remotePath: tested.remotePath },
    remoteCwd: tested.remotePath
  };
}

function remoteSystemPrompt(systemPrompt: string, localCwd: string, connection: RemoteConnectionRecord, remoteCwd: string): string {
  const replacement = `Current working directory: ${remoteCwd} (via SSH: ${remoteLabel({ ...connection, remotePath: remoteCwd })})`;
  if (systemPrompt.includes(`Current working directory: ${localCwd}`)) {
    return systemPrompt.replace(`Current working directory: ${localCwd}`, replacement);
  }
  return `${systemPrompt}\n\n${replacement}`;
}

type WebSearchToolDetails = {
  results: WebSearchResult[];
};

type AskUserQuestionToolDetails = {
  questions: Array<{
    id: string;
    question: string;
    options: string[];
  }>;
  answers: Array<{
    questionId: string;
    answer: string;
    wasCustom: boolean;
    selectedIndex?: number;
  }>;
};

const AskUserQuestionOptionSchema = Type.Object({
  label: Type.String({ description: "Display label for this option" }),
  description: Type.Optional(Type.String({ description: "Optional short description shown under the option" }))
});

const AskUserQuestionItemSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable short identifier for this question, such as scope or priority" })),
  header: Type.Optional(Type.String({ description: "Short label shown above this question" })),
  question: Type.String({ description: "The exact question to ask the user" }),
  options: Type.Array(AskUserQuestionOptionSchema, { description: "Two or three concrete options for this question. Jasmine will also allow a custom Other answer." })
});

const AskUserQuestionParams = Type.Object({
  questions: Type.Optional(Type.Array(AskUserQuestionItemSchema, { description: "One to three short multiple-choice questions to ask together before continuing." })),
  question: Type.Optional(Type.String({ description: "Legacy single-question form. Prefer questions[]." })),
  options: Type.Optional(Type.Array(AskUserQuestionOptionSchema, { description: "Legacy single-question options. Prefer questions[].options. Provide two or three options." }))
});

export function createAskUserQuestionTool(
  ask: (prompt: Omit<AskUserQuestionPrompt, "id">, signal?: AbortSignal) => Promise<AskUserQuestionResponse>
): ToolDefinition {
  return defineTool({
    name: "AskUserQuestion",
    label: "Ask User Question",
    description: [
      "Ask the user one to three multiple-choice questions in one dialog and wait for all answers before continuing.",
      "Only call AskUserQuestion when the context prompt explicitly says AskUserQuestion is allowed for the current task.",
      "Do not call this tool for ordinary clarification or convenience when that explicit permission is absent.",
      "Always provide concrete options for each question; Jasmine will also let the user type an Other answer."
    ].join(" "),
    promptSnippet: "AskUserQuestion asks the user one to three multiple-choice questions and waits for all answers.",
    promptGuidelines: [
      "Only use AskUserQuestion when the context prompt explicitly permits AskUserQuestion for the current task.",
      "Do not ask the user questions through this tool merely because information is missing; proceed with reasonable assumptions unless explicit AskUserQuestion permission exists.",
      "Prefer batching related questions into one AskUserQuestion call instead of making a chain of separate tool calls.",
      "Provide concise options for each question. The UI also allows the user to enter an Other answer."
    ],
    parameters: AskUserQuestionParams,
    async execute(_toolCallId, params, signal) {
      const questions = normalizeAskUserQuestions(params);
      if (questions.length === 0) {
        return askUserQuestionError("Error: AskUserQuestion requires one to three questions, each with question text and two or three options.", []);
      }
      const response = await ask({ questions }, signal);
      const details: AskUserQuestionToolDetails = {
        questions: questions.map((question) => ({
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label)
        })),
        answers: response.answers.map((answer) => ({
          questionId: answer.questionId,
          answer: answer.answer,
          wasCustom: answer.custom,
          selectedIndex: answer.selectedIndex
        }))
      };
      return {
        content: [{
          type: "text",
          text: [
            "User has answered your questions:",
            ...response.answers.map((answer) => {
              const selected = answer.custom ? "custom" : String(answer.selectedIndex ?? "?");
              return `- ${answer.questionId} (${selected}): ${answer.answer}`;
            })
          ].join("\n")
        }],
        details
      };
    }
  });
}

export function createWebSearchTool(
  search: (query: string, signal?: AbortSignal) => Promise<WebSearchResult[]>
): ToolDefinition {
  return defineTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web for current or external information and return source URLs.",
    promptSnippet: "Search the web for current or external information and return source URLs",
    promptGuidelines: [
      "Use web_search when the user asks for current information, web content, or facts that may have changed.",
      "Cite URLs from web_search results when those results affect the answer."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" })
    }),
    async execute(_toolCallId, params, signal) {
      const results = await search(params.query, signal);
      return {
        content: [{ type: "text", text: formatWebSearchResults(results) }],
        details: { results } satisfies WebSearchToolDetails
      };
    }
  });
}

function askUserQuestionError(
  message: string,
  questions: AskUserQuestionPrompt["questions"]
): { content: Array<{ type: "text"; text: string }>; details: AskUserQuestionToolDetails } {
  return {
    content: [{ type: "text", text: message }],
    details: {
      questions: questions.map((question) => ({
        id: question.id,
        question: question.question,
        options: question.options.map((option) => option.label)
      })),
      answers: []
    }
  };
}

function normalizeAskUserQuestions(params: Record<string, unknown>): AskUserQuestionPrompt["questions"] {
  const rawQuestions = Array.isArray(params.questions)
    ? params.questions
    : typeof params.question === "string"
      ? [{ question: params.question, options: params.options }]
      : [];
  const usedIds = new Set<string>();
  return rawQuestions.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const options = normalizeAskUserQuestionOptions(record.options);
    if (!question || options.length < 2) return [];
    const baseId = typeof record.id === "string" && record.id.trim()
      ? record.id.trim().slice(0, 80)
      : `question_${index + 1}`;
    const id = uniqueAskUserQuestionId(baseId, index, usedIds);
    const header = typeof record.header === "string" && record.header.trim()
      ? record.header.trim().slice(0, 40)
      : `Question ${index + 1}`;
    return [{
      id,
      header,
      question: question.slice(0, 1200),
      options
    }];
  }).slice(0, 3);
}

function uniqueAskUserQuestionId(baseId: string, index: number, usedIds: Set<string>): string {
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${baseId || "question"}_${index + 1}_${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

function normalizeAskUserQuestionOptions(value: unknown): AskUserQuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    if (!label) return [];
    return [{
      label: label.slice(0, 400),
      ...(description ? { description: description.slice(0, 800) } : {})
    }];
  }).slice(0, 3);
}

function historyBeforePrompt(messages: ChatSendRequest["messages"], content: string, attachments: PickedPath[]): ChatSendRequest["messages"] {
  const last = messages.at(-1);
  if (last?.role === "user" && last.content.trim() === content.trim() && sameAttachments(last.attachments ?? [], attachments)) {
    return messages.slice(0, -1);
  }
  return messages;
}

type PiAppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

async function appendHistoricalMessage(sessionManager: SessionManager, message: ChatSendRequest["messages"][number], provider: RuntimeProviderConfig): Promise<void> {
  const restored = await timelineToPiMessages(message, provider);
  if (restored.length === 0) {
    sessionManager.appendMessage(await toPiMessage(message, provider));
    return;
  }
  for (const item of restored) {
    sessionManager.appendMessage(item);
  }
}

async function timelineToPiMessages(message: ChatSendRequest["messages"][number], provider: RuntimeProviderConfig): Promise<PiAppendableMessage[]> {
  if (message.role === "user") return [await toPiMessage(message, provider)];
  if (!message.timeline?.length) return [];

  const output: PiAppendableMessage[] = [];
  let assistantBlocks: AssistantMessage["content"] = [];
  let assistantBlocksIncludeToolCall = false;
  const toolCallIdsByName = new Map<string, string[]>();
  let latestToolCallId: string | null = null;
  const timelineWasStopped = message.timeline.some((item) => item.kind === "system" && item.title.toLowerCase() === "stopped");

  const flushAssistant = (stopReason: AssistantMessage["stopReason"] = "stop") => {
    if (assistantBlocks.length === 0) return;
    output.push(toPiAssistantMessage(assistantBlocks, provider, stopReason));
    assistantBlocks = [];
    assistantBlocksIncludeToolCall = false;
  };

  for (const item of message.timeline) {
    if (item.kind === "thinking") {
      assistantBlocks.push({ type: "thinking", thinking: item.text } satisfies ThinkingContent);
      continue;
    }
    if (item.kind === "assistant_text") {
      if (item.text.trim()) assistantBlocks.push({ type: "text", text: item.text } satisfies TextContent);
      continue;
    }
    if (item.kind === "tool_call") {
      const callId = item.id || `${item.toolName}-${toolCallIdsByName.size + 1}`;
      latestToolCallId = callId;
      const queue = toolCallIdsByName.get(item.toolName) ?? [];
      queue.push(callId);
      toolCallIdsByName.set(item.toolName, queue);
      assistantBlocks.push({
        type: "toolCall",
        id: callId,
        name: item.toolName,
        arguments: parseToolArguments(item.argumentsJson)
      } satisfies ToolCall);
      assistantBlocksIncludeToolCall = true;
      continue;
    }
    if (item.kind === "tool_result") {
      flushAssistant(assistantBlocksIncludeToolCall ? "toolUse" : "stop");
      const toolCallId = shiftToolCallId(toolCallIdsByName, item.toolName) ?? latestToolCallId ?? item.id;
      output.push({
        role: "toolResult",
        toolCallId,
        toolName: item.toolName,
        content: [{ type: "text", text: item.content }] satisfies TextContent[],
        isError: Boolean(item.isError),
        timestamp: Date.now()
      } satisfies ToolResultMessage);
    }
  }

  flushAssistant(assistantBlocksIncludeToolCall ? "toolUse" : "stop");
  if (timelineWasStopped) {
    for (const [toolName, toolCallIds] of toolCallIdsByName.entries()) {
      for (const toolCallId of toolCallIds) {
        output.push(stoppedToolResultMessage(toolCallId, toolName));
      }
    }
  }
  if (output.length === 0 && message.content.trim()) {
    output.push(await toPiMessage(message, provider));
  }
  return output;
}

function stoppedToolResultMessage(toolCallId: string, toolName: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "Tool call was stopped by the user." }] satisfies TextContent[],
    isError: true,
    timestamp: Date.now()
  } satisfies ToolResultMessage;
}

function shiftToolCallId(toolCallIdsByName: Map<string, string[]>, toolName: string): string | undefined {
  const queue = toolCallIdsByName.get(toolName);
  if (!queue || queue.length === 0) return undefined;
  const value = queue.shift();
  if (queue.length === 0) toolCallIdsByName.delete(toolName);
  return value;
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function toPiMessage(message: ChatSendRequest["messages"][number], provider: RuntimeProviderConfig): Promise<Message> {
  if (message.role === "user") {
    const attachments = message.attachments ?? [];
    const images = attachments.filter((item) => item.kind === "file" && item.isImage);
    const text = promptText(message.content, attachments);
    if (images.length > 0) {
      return {
        role: "user",
        content: [{ type: "text", text } satisfies TextContent, ...await imageContent(images)],
        timestamp: Date.now()
      };
    }
    return {
      role: "user",
      content: text,
      timestamp: Date.now()
    };
  }

  return toPiAssistantMessage([{ type: "text", text: message.content } satisfies TextContent], provider, "stop");
}

function toPiAssistantMessage(content: AssistantMessage["content"], provider: RuntimeProviderConfig, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: provider.providerName,
    model: provider.modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason,
    timestamp: Date.now()
  } satisfies AssistantMessage;
}

function sameAttachments(first: PickedPath[], second: PickedPath[]): boolean {
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

function toPiModel(provider: RuntimeProviderConfig): Model<"openai-completions"> {
  const supportsVision = Boolean(provider.capabilities?.vision);
  const supportsReasoning = Boolean(provider.capabilities?.reasoning);
  const providerSpecific = providerSpecificPiModelConfig(provider);
  return {
    id: provider.modelId,
    name: provider.modelId,
    api: "openai-completions",
    provider: provider.providerName,
    baseUrl: provider.baseUrl,
    reasoning: supportsReasoning,
    ...(providerSpecific.thinkingLevelMap ? { thinkingLevelMap: providerSpecific.thinkingLevelMap } : {}),
    input: supportsVision ? ["text", "image"] : ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: provider.contextWindow ?? 128_000,
    maxTokens: provider.maxOutputTokens ?? maxOutputTokensFromOptions(provider.providerOptionsJson) ?? 1_200,
    compat: {
      supportsStore: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      ...providerSpecific.compat
    }
  };
}

type PiOpenAICompat = NonNullable<Model<"openai-completions">["compat"]>;
type PiThinkingLevelMap = NonNullable<Model<"openai-completions">["thinkingLevelMap"]>;

function providerSpecificPiModelConfig(provider: RuntimeProviderConfig): {
  compat?: PiOpenAICompat;
  thinkingLevelMap?: PiThinkingLevelMap;
} {
  if (!provider.capabilities?.reasoning) return {};

  if (isDeepSeekV4Model(provider)) {
    return {
      compat: {
        thinkingFormat: "deepseek",
        supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true
      },
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: "max"
      }
    };
  }

  if (isMoonshotKimiAlwaysThinkingModel(provider)) {
    return {
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
        thinkingFormat: "openai"
      },
      thinkingLevelMap: {
        off: null
      }
    };
  }

  if (isMoonshotKimiThinkingToggleModel(provider)) {
    return {
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
        thinkingFormat: "deepseek"
      }
    };
  }

  return {};
}

function isDeepSeekV4Model(provider: RuntimeProviderConfig): boolean {
  return isDeepSeekProvider(provider) && normalizeModelId(provider.modelId).includes("deepseek-v4");
}

function isDeepSeekProvider(provider: RuntimeProviderConfig): boolean {
  const providerName = provider.providerName.toLowerCase();
  const baseUrl = provider.baseUrl.toLowerCase();
  return providerName === "deepseek" || baseUrl.includes("deepseek.com");
}

function isMoonshotKimiThinkingToggleModel(provider: RuntimeProviderConfig): boolean {
  if (!isMoonshotProvider(provider)) return false;
  const modelId = normalizeModelId(provider.modelId);
  return modelId.includes("kimi-k2.5")
    || modelId.includes("kimi-k2.6")
    || modelId.includes("kimi-k2-thinking");
}

function isMoonshotKimiAlwaysThinkingModel(provider: RuntimeProviderConfig): boolean {
  if (!isMoonshotProvider(provider)) return false;
  const modelId = normalizeModelId(provider.modelId);
  return modelId.includes("kimi-k2.7-code");
}

function isMoonshotProvider(provider: RuntimeProviderConfig): boolean {
  const providerName = provider.providerName.toLowerCase();
  const baseUrl = provider.baseUrl.toLowerCase();
  return providerName === "moonshot"
    || providerName === "moonshotai"
    || providerName === "moonshotai-cn"
    || baseUrl.includes("api.moonshot.");
}

function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase();
}

function promptText(content: string, attachments: PickedPath[]): string {
  const textLines = [content.trim() || attachmentOnlyPrompt(attachments)];
  if (attachments.length > 0) {
    textLines.push(
      "",
      "Attached local paths:",
      ...attachments.map(formatAttachmentPath)
    );
  }
  return textLines.join("\n");
}

function promptAnchorText(content: string, attachments: PickedPath[]): string {
  return content.trim() || attachmentOnlyPrompt(attachments);
}

async function imageContent(images: PickedPath[]): Promise<ImageContent[]> {
  return Promise.all(
    images.map(async (image) => {
      const fallback = decodePreviewDataUrl(image.previewDataUrl);
      return {
        type: "image" as const,
        data: await readImageBase64(image, fallback),
        mimeType: image.mediaType ?? fallback?.mimeType ?? "image/png"
      };
    })
  );
}

async function readImageBase64(image: PickedPath, fallback: { mimeType: string; data: string } | null): Promise<string> {
  try {
    return (await readFile(image.path)).toString("base64");
  } catch (error) {
    if (fallback) return fallback.data;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Image attachment file is unavailable: ${image.path}. ${message}`);
  }
}

function formatAttachmentPath(item: PickedPath): string {
  const label = item.isImage ? "image file" : item.kind;
  const media = item.mediaType ? ` (${item.mediaType})` : "";
  return `- ${label}${media}: ${item.path}`;
}

function decodePreviewDataUrl(value?: string): { mimeType: string; data: string } | null {
  if (!value) return null;
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(value);
  if (!match) return null;
  const mimeType = match[1] || "image/png";
  const payload = match[3] || "";
  try {
    const data = match[2]
      ? payload
      : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64");
    return data ? { mimeType, data } : null;
  } catch {
    return null;
  }
}

function attachmentOnlyPrompt(attachments: PickedPath[]): string {
  if (attachments.some((item) => item.isImage)) return "Please analyze the attached image.";
  return "Please review the attached item.";
}

function maxOutputTokensFromOptions(value?: string): number | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { maxOutputTokens?: unknown; maxTokens?: unknown };
    if (typeof parsed.maxOutputTokens === "number") return parsed.maxOutputTokens;
    if (typeof parsed.maxTokens === "number") return parsed.maxTokens;
  } catch {
    return undefined;
  }
  return undefined;
}

function restoreTimelineCustomEntries(sessionManager: SessionManager, timeline: ChatTimelineItem[] | undefined): void {
  if (!timeline) return;
  for (const item of timeline) {
    if (item.kind !== "system" || !item.customType) continue;
    if (item.customType === "context-taxonomy") continue;
    if (item.origin !== "pi-extension" && item.customType !== "web-search-results") continue;
    sessionManager.appendCustomEntry(item.customType, item.data);
  }
}

function formatWebSearchResults(results: WebSearchResult[]): string {
  if (results.length === 0) return "No web search results found.";
  return results.map((result, index) => [
    `${index + 1}. ${result.title}`,
    `URL: ${result.url}`,
    `Snippet: ${result.snippet || "No snippet available."}`
  ].join("\n")).join("\n\n");
}

function sessionEntriesToTimeline(entries: SessionEntry[], fallbackText: string): ChatTimelineItem[] {
  const timeline = entries.flatMap((entry) => entryToTimeline(entry));
  if (timeline.some((item) => item.kind === "assistant_text")) return timeline;
  if (!fallbackText.trim()) return timeline;
  return [
    ...timeline,
    {
      id: "assistant-output",
      kind: "assistant_text" as const,
      text: fallbackText.trim()
    }
  ];
}

function sessionEntriesToMessages(
  entries: SessionEntry[],
  fallbackText: string,
  initialPromptText: string,
  deliveredQueuedMessages: TrackedQueuedMessage[]
): RuntimeGeneratedMessage[] {
  const output: RuntimeGeneratedMessage[] = [];
  let skippedInitialPrompt = false;
  let pendingTimeline: ChatTimelineItem[] = [];

  const flushAssistant = (fallback = "") => {
    const content = (assistantTextFromTimeline(pendingTimeline) || fallback).trim();
    if (!content && !hasVisibleAssistantTimelineActivity(pendingTimeline)) {
      pendingTimeline = [];
      return;
    }
    output.push({
      role: "assistant",
      content,
      timeline: pendingTimeline
    });
    pendingTimeline = [];
  };

  for (const entry of entries) {
    const userText = userTextFromSessionEntry(entry);
    if (userText !== null) {
      flushAssistant();
      if (!skippedInitialPrompt && userText.trim() === initialPromptText.trim()) {
        skippedInitialPrompt = true;
        continue;
      }
      const queued = shiftDeliveredQueuedMessage(deliveredQueuedMessages, userText);
      output.push({
        role: "user",
        content: queued?.content ?? userText.trim(),
        attachments: queued?.attachments ?? []
      });
      continue;
    }

    const timeline = entryToTimeline(entry);
    if (timeline.length > 0) {
      pendingTimeline = mergeTimelineItems(pendingTimeline, timeline);
    }
  }

  flushAssistant(fallbackText);
  return output;
}

function hasVisibleAssistantTimelineActivity(timeline: ChatTimelineItem[]): boolean {
  return timeline.some((item) => {
    if (item.kind === "assistant_text" || item.kind === "thinking") return item.text.trim().length > 0;
    if (item.kind === "tool_call" || item.kind === "tool_result") return true;
    if (item.kind !== "system") return false;
    if (item.title === "Model" || item.title === "Thinking level" || item.customType) return false;
    return item.title.trim().length > 0 || item.text.trim().length > 0;
  });
}

function userTextFromSessionEntry(entry: SessionEntry): string | null {
  if (entry.type !== "message") return null;
  const message = entry.message as unknown as Record<string, unknown>;
  if (message.role !== "user") return null;
  return contentToText(message.content).trim();
}

function shiftDeliveredQueuedMessage(deliveredQueuedMessages: TrackedQueuedMessage[], userText: string): TrackedQueuedMessage | undefined {
  const normalized = userText.trim();
  const exactIndex = deliveredQueuedMessages.findIndex((item) => item.piText.trim() === normalized);
  if (exactIndex >= 0) {
    const [item] = deliveredQueuedMessages.splice(exactIndex, 1);
    return item;
  }
  return deliveredQueuedMessages.shift();
}

function liveTimelineFromSession(
  sessionManager: SessionManager,
  previousEntryCount: number,
  fallbackText: string,
  updateTimeline: ChatTimelineItem[],
  previousTimeline: ChatTimelineItem[]
): ChatTimelineItem[] {
  const entriesTimeline = sessionEntriesToTimeline(sessionManager.getEntries().slice(previousEntryCount), fallbackText);
  if (entriesTimeline.length > 0) return entriesTimeline;
  return mergeTimelineItems(previousTimeline, updateTimeline);
}

function streamEventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as Record<string, unknown>;
  return typeof value.type === "string" ? value.type : undefined;
}

function foldInFlightTimeline(messages: RuntimeGeneratedMessage[], timeline: ChatTimelineItem[]): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") {
    const merged = mergeTimelineItems(last.timeline ?? [], timeline);
    messages[messages.length - 1] = {
      ...last,
      timeline: merged,
      content: assistantTextFromTimeline(merged).trim() || last.content
    };
    return;
  }
  messages.push({
    role: "assistant",
    content: assistantTextFromTimeline(timeline).trim(),
    timeline
  });
}

function lastAssistantMessage(messages: RuntimeGeneratedMessage[]): RuntimeGeneratedMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return messages[index];
  }
  return undefined;
}

function assistantTextFromTimeline(timeline: ChatTimelineItem[]): string {
  return timeline
    .filter((item): item is Extract<ChatTimelineItem, { kind: "assistant_text" }> => item.kind === "assistant_text")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function mergeTimelineItems(existing: ChatTimelineItem[], incoming: ChatTimelineItem[]): ChatTimelineItem[] {
  if (existing.length === 0) return [...incoming];
  if (incoming.length === 0) return [...existing];
  const merged = [...existing];
  for (const item of incoming) {
    const index = merged.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) {
      merged[index] = item;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function entryToTimeline(entry: SessionEntry): ChatTimelineItem[] {
  if (entry.type === "thinking_level_change") {
    return [{
      id: entry.id,
      kind: "system",
      title: "Thinking level",
      text: entry.thinkingLevel
    }];
  }
  if (entry.type === "model_change") {
    return [{
      id: entry.id,
      kind: "system",
      title: "Model",
      text: `${entry.provider}/${entry.modelId}`
    }];
  }
  if (entry.type === "compaction") {
    return [{
      id: entry.id,
      kind: "system",
      title: "Compaction",
      text: entry.summary
    }];
  }
  if (entry.type === "branch_summary") {
    return [{
      id: entry.id,
      kind: "system",
      title: "Branch summary",
      text: entry.summary
    }];
  }
  if (entry.type === "custom_message" && entry.display) {
    return [{
      id: entry.id,
      kind: "system",
      title: entry.customType,
      text: contentToText(entry.content)
    }];
  }
  if (entry.type === "custom") {
    return [{
      id: entry.id,
      kind: "system",
      title: entry.customType,
      text: summarizeCustomEntry(entry.customType, entry.data),
      customType: entry.customType,
      origin: "pi-extension",
      data: entry.data
    }];
  }
  if (entry.type !== "message") return [];

  const message = entry.message as unknown as Record<string, unknown>;
  if (message.role === "toolResult") {
    return [{
      id: entry.id,
      kind: "tool_result",
      toolName: stringValue(message.toolName, "tool"),
      title: stringValue(message.toolName, "Tool result"),
      content: contentToText(message.content),
      isError: Boolean(message.isError)
    }];
  }
  if (message.role === "bashExecution") {
    return [{
      id: entry.id,
      kind: "tool_result",
      toolName: "bash",
      title: stringValue(message.command, "Shell"),
      content: stringValue(message.output, ""),
      isError: Number(message.exitCode ?? 0) !== 0 || Boolean(message.cancelled)
    }];
  }
  if (message.role === "custom") {
    if (message.display === false) return [];
    return [{
      id: entry.id,
      kind: "system",
      title: stringValue(message.customType, "Custom message"),
      text: contentToText(message.content)
    }];
  }
  if (message.role !== "assistant") return [];

  const content = Array.isArray(message.content) ? message.content : [];
  return content.flatMap((block, index): ChatTimelineItem[] => {
    if (!block || typeof block !== "object") return [];
    const value = block as Record<string, unknown>;
    if (value.type === "thinking") {
      return [{
        id: `${entry.id}-${index}`,
        kind: "thinking",
        text: stringValue(value.thinking, "")
      } satisfies ChatTimelineItem];
    }
    if (value.type === "toolCall") {
      const name = stringValue(value.name, "tool");
      return [{
        id: stringValue(value.id, `${entry.id}-${index}`),
        kind: "tool_call",
        toolName: name,
        title: name,
        argumentsJson: safeJson(value.arguments)
      } satisfies ChatTimelineItem];
    }
    if (value.type === "text") {
      const text = stringValue(value.text, "");
      if (!text.trim()) return [];
      return [{
        id: `${entry.id}-${index}`,
        kind: "assistant_text",
        text
      } satisfies ChatTimelineItem];
    }
    return [];
  });
}

function eventToLiveUpdate(event: unknown): PiCodingAgentChatResult | null {
  if (!event || typeof event !== "object") return null;
  const value = event as Record<string, unknown>;
  if (value.type !== "message_update" && value.type !== "message_end") return null;
  const message = value.message as Record<string, unknown> | undefined;
  if (!message) return null;
  const content = message.role === "assistant" ? contentToText(message.content) : "";
  const timeline = messageToTimeline(String(value.type), message, content);
  if (!content.trim() && timeline.length === 0) return null;
  return { content, timeline, webSearchUsed: [] };
}

function isQueueUpdateEvent(event: unknown): event is { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] } {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.type === "queue_update" && Array.isArray(value.steering) && Array.isArray(value.followUp);
}

function summarizeCustomEntry(customType: string, data: unknown): string {
  if (customType !== "web-search-results") return "Extension state saved.";
  if (!data || typeof data !== "object") return "Web search state saved.";
  const value = data as Record<string, unknown>;
  const id = stringValue(value.id, "");
  const type = stringValue(value.type, "search");
  const count = Array.isArray(value.queries)
    ? value.queries.length
    : Array.isArray(value.urls)
      ? value.urls.length
      : 0;
  return `${type === "fetch" ? "Fetched content" : "Search results"} saved${id ? ` as ${id}` : ""}${count ? ` (${count})` : ""}.`;
}

function mergeDerivedWebSearchResults(existing: WebSearchResult[], entries: SessionEntry[]): WebSearchResult[] {
  const merged = [...existing];
  for (const entry of entries) {
    for (const result of extractWebSearchResults(entry)) {
      if (!merged.some((item) => item.url === result.url)) merged.push(result);
    }
  }
  return merged;
}

function extractWebSearchResults(entry: SessionEntry): WebSearchResult[] {
  if (entry.type !== "custom" || entry.customType !== "web-search-results") return [];
  const data = entry.data;
  if (!data || typeof data !== "object") return [];
  const value = data as Record<string, unknown>;
  if (Array.isArray(value.queries)) {
    return value.queries.flatMap((query) => {
      if (!query || typeof query !== "object") return [];
      const results = (query as Record<string, unknown>).results;
      return Array.isArray(results) ? results.map(toWebSearchResult).filter((item): item is WebSearchResult => Boolean(item)) : [];
    });
  }
  if (Array.isArray(value.urls)) {
    return value.urls.map(toFetchedWebSearchResult).filter((item): item is WebSearchResult => Boolean(item));
  }
  return [];
}

function toWebSearchResult(item: unknown): WebSearchResult | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Record<string, unknown>;
  const url = stringValue(value.url, "");
  if (!url) return null;
  return {
    title: stringValue(value.title, url),
    url,
    snippet: stringValue(value.snippet, stringValue(value.content, ""))
  };
}

function toFetchedWebSearchResult(item: unknown): WebSearchResult | null {
  if (!item || typeof item !== "object") return null;
  const value = item as Record<string, unknown>;
  const url = stringValue(value.url, "");
  if (!url) return null;
  return {
    title: stringValue(value.title, url),
    url,
    snippet: stringValue(value.error, "") || stringValue(value.content, "").slice(0, 240)
  };
}

function messageToTimeline(idPrefix: string, message: Record<string, unknown>, fallbackText: string): ChatTimelineItem[] {
  if (message.role === "toolResult") {
    return [{
      id: `${idPrefix}-tool-result`,
      kind: "tool_result",
      toolName: stringValue(message.toolName, "tool"),
      title: stringValue(message.toolName, "Tool result"),
      content: contentToText(message.content),
      isError: Boolean(message.isError)
    }];
  }
  if (message.role !== "assistant") return [];

  const content = Array.isArray(message.content) ? message.content : [];
  const timeline = content.flatMap((block, index): ChatTimelineItem[] => {
    if (!block || typeof block !== "object") return [];
    const value = block as Record<string, unknown>;
    if (value.type === "thinking") {
      return [{
        id: `${idPrefix}-thinking-${index}`,
        kind: "thinking",
        text: stringValue(value.thinking, "")
      }];
    }
    if (value.type === "toolCall") {
      const name = stringValue(value.name, "tool");
      return [{
        id: `${idPrefix}-tool-call-${index}`,
        kind: "tool_call",
        toolName: name,
        title: name,
        argumentsJson: safeJson(value.arguments)
      }];
    }
    if (value.type === "text") {
      const text = stringValue(value.text, "");
      if (!text.trim()) return [];
      return [{
        id: `${idPrefix}-text-${index}`,
        kind: "assistant_text",
        text
      }];
    }
    return [];
  });
  if (timeline.length > 0) return timeline;
  return fallbackText.trim() ? [{ id: `${idPrefix}-text`, kind: "assistant_text", text: fallbackText.trim() }] : [];
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const value = block as Record<string, unknown>;
    if (value.type === "text") return stringValue(value.text, "");
    if (value.type === "image") return "[Image]";
    return "";
  }).filter(Boolean).join("\n");
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}
