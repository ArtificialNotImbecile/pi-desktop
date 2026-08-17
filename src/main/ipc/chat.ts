import { app, ipcMain, type WebContents } from "electron";
import type {
  AskUserQuestionPrompt,
  ChatContextTaxonomyCaptureUpdateRequest,
  ChatEditRequest,
  ChatEditResponse,
  ChatQueueDeleteRequest,
  ChatMessage,
  ChatQueueRequest,
  ChatQueueResponse,
  ChatQueueSteerRequest,
  ChatQueueUpdateRequest,
  ChatQueueState,
  MemoryReference,
  PickedPath,
  PluginReference,
  ChatRetryRequest,
  ChatRetryResponse,
  ChatSendRequest,
  ChatSendResponse,
  ChatStreamSettlement,
  ChatStreamMessage,
  ChatTimelineItem,
  ContextTaxonomy,
  FileChangeCaptureInput,
  ReasoningEffort,
  SkillRecord,
  SkillReference,
  WebSearchResult
} from "../../shared/ipc.js";
import { chatContextTaxonomyCaptureUpdateRequestSchema, chatEditRequestSchema, chatQueueDeleteRequestSchema, chatQueueRequestSchema, chatQueueSteerRequestSchema, chatQueueUpdateRequestSchema, chatRetryRequestSchema, chatSendRequestSchema } from "../../shared/schemas.js";
import { WORKING_ACTIVITY, usingToolActivity, type WorkingActivity } from "../../shared/workingActivity.js";
import { computeStreamDelta } from "../../shared/streamDelta.js";
import { createChatStreamSettlement } from "../../shared/streamSettlement.js";
import { generateAssistantReply } from "../agent/runtime.js";
import type { AssistantReply, RuntimeGeneratedMessage, RuntimeQueueControls } from "../agent/runtime.js";
import type { JasmineDatabase } from "../db/database.js";
import { askUserQuestionInRenderer } from "./askUserQuestion.js";
import { requestPermissionApprovalInRenderer } from "./permissionApproval.js";
import { sanitizePermissionDisplay, type PermissionApprovalRequest } from "../agent/extensions/permissionGate/index.js";
import { getRuntimeProvider } from "../services/providers.js";
import { getJasminePiAgentDir } from "../services/piAgent.js";
import { appendThreadSessionName, branchParentForMessage, prepareThreadPiSession } from "../services/piSessions.js";
import {
  resolveEnabledPackageSkillPaths,
  resolvePluginPackageReferences,
  resolvePluginPackageRuntimeSources,
  resolvePluginSkillsForPrompt
} from "../services/plugins.js";
import { getPromptTemplatePaths } from "../services/promptTemplates.js";
import { prepareEnabledSkillManifests, prepareSkillManifests } from "../services/skillManifests.js";
import { mergeRuntimeSkills, pluginReferenceIds, skillReferenceIds } from "../services/skillRuntimeContext.js";
import { generateTitleWithProviderResult } from "../services/threadTitles.js";
import {
  buildRetryPlan,
  modelContentForMessage,
  nonSecretError,
  summarizeInput,
  summarizeOutput,
  titleFromAttachments,
  titleFromMessage,
  toModelHistoryMessage
} from "./chatSupport.js";
import type { IpcContext } from "./context.js";
import type { WorkingRegistry } from "../services/workingRegistry.js";

type ActiveRun = {
  threadId: string;
  abortController: AbortController;
  captureContextTaxonomy: boolean;
  streamSettled: boolean;
  queueControls?: RuntimeQueueControls;
  queueReady: Promise<RuntimeQueueControls>;
  resolveQueueReady(controls: RuntimeQueueControls): void;
  rejectQueueReady(error: Error): void;
};

const activeRuns = new Map<string, ActiveRun>();

export function registerChatIpc(context: IpcContext): void {
  const working = context.getWorkingRegistry();
  working.setStopHandler((requestId) => {
    const run = activeRuns.get(requestId);
    if (!run) return false;
    run.abortController.abort();
    return true;
  });

  ipcMain.handle("chat:cancel", (_event, requestId: string): boolean => {
    return working.stop(requestId);
  });

  ipcMain.handle("chat:contextTaxonomyCapture:update", (_event, input: ChatContextTaxonomyCaptureUpdateRequest): boolean => {
    const request = chatContextTaxonomyCaptureUpdateRequestSchema.parse(input);
    let updated = false;
    for (const run of activeRuns.values()) {
      if (run.threadId !== request.threadId) continue;
      run.captureContextTaxonomy = request.enabled;
      updated = true;
    }
    return updated;
  });

  ipcMain.handle("chat:queue", async (_event, request: ChatQueueRequest): Promise<ChatQueueResponse> => {
    request = chatQueueRequestSchema.parse(request);
    const run = activeQueueRun(request.requestId, request.threadId);
    const content = request.content.trim();
    const attachments = request.attachments ?? [];
    if (!content && attachments.length === 0) throw new Error("Message content is empty.");
    if (run.abortController.signal.aborted) throw new Error("Response is already stopping.");
    const controls = run.queueControls ?? await run.queueReady;
    const queue = await controls.queueMessage({
        mode: request.mode,
        content,
        attachments
      });
    working.queue(request.requestId, queueCount(queue));
    return { queue };
  });

  ipcMain.handle("chat:queue:update", async (_event, request: ChatQueueUpdateRequest): Promise<ChatQueueResponse> => {
    request = chatQueueUpdateRequestSchema.parse(request);
    const run = activeQueueRun(request.requestId, request.threadId);
    const content = request.content.trim();
    const attachments = request.attachments ?? [];
    if (!content && attachments.length === 0) throw new Error("Message content is empty.");
    if (run.abortController.signal.aborted) throw new Error("Response is already stopping.");
    const controls = run.queueControls ?? await run.queueReady;
    const queue = await controls.updateMessage({
        id: request.messageId,
        content,
        attachments
      });
    working.queue(request.requestId, queueCount(queue));
    return { queue };
  });

  ipcMain.handle("chat:queue:delete", async (_event, request: ChatQueueDeleteRequest): Promise<ChatQueueResponse> => {
    request = chatQueueDeleteRequestSchema.parse(request);
    const run = activeQueueRun(request.requestId, request.threadId);
    if (run.abortController.signal.aborted) throw new Error("Response is already stopping.");
    const controls = run.queueControls ?? await run.queueReady;
    const queue = await controls.deleteMessage(request.messageId);
    working.queue(request.requestId, queueCount(queue));
    return { queue };
  });

  ipcMain.handle("chat:queue:steer", async (_event, request: ChatQueueSteerRequest): Promise<ChatQueueResponse> => {
    request = chatQueueSteerRequestSchema.parse(request);
    const run = activeQueueRun(request.requestId, request.threadId);
    if (run.abortController.signal.aborted) throw new Error("Response is already stopping.");
    const controls = run.queueControls ?? await run.queueReady;
    const queue = await controls.steerMessage(request.messageId);
    working.queue(request.requestId, queueCount(queue));
    return { queue };
  });

  ipcMain.handle("chat:send", async (_event, request: ChatSendRequest): Promise<ChatSendResponse> => {
    const db = context.getDatabase();
    request = chatSendRequestSchema.parse(request);
    const requestId = request.requestId ?? `main-${crypto.randomUUID()}`;
    const abortController = new AbortController();
    const content = request.content.trim();
    const attachments = request.attachments ?? [];
    if (!content && attachments.length === 0) throw new Error("Message content is empty.");
    if (!db.hasThread(request.threadId)) throw new Error("Thread does not exist.");
    const inlinePluginIds = request.inlinePluginIds ?? db.getThread(request.threadId)?.activePluginIds ?? [];
    db.updateThreadActivePlugins({ threadId: request.threadId, pluginIds: inlinePluginIds });
    const cwd = db.getThreadCwd(request.threadId);
    const startedAt = Date.now();
    const initialSettlementAnchorId = db.listMessagesPage({ threadId: request.threadId, limit: 1 }).at(-1)?.id;
    let abortedSettlement = createChatStreamSettlement(
      requestId,
      initialSettlementAnchorId,
      [],
      [],
      true
    );
    activeRuns.set(requestId, createActiveRun(request.threadId, abortController, request.captureContextTaxonomy === true));
    working.start({ requestId, threadId: request.threadId });

    try {
      const userDataDir = app.getPath("userData");
      const inlineSkills = await db.getSkillsForPrompt(request.inlineSkillIds);
      const inlinePluginSkills = await resolvePluginSkillsForPrompt({ userDataDir }, request.inlineSkillIds);
      const inlinePluginsUsed = await resolvePluginPackageReferences({ userDataDir }, inlinePluginIds);
      const inlinePluginSources = await resolvePluginPackageRuntimeSources({ userDataDir }, inlinePluginIds);
      const inlineSkillsUsed = toExplicitSkillReferences(mergeRuntimeSkills(inlineSkills, inlinePluginSkills));
      const previousCount = db.getThreadMessageCount(request.threadId);
      const userMessage = db.addMessage({
        threadId: request.threadId,
        role: "user",
        content,
        attachments,
        skillsUsed: inlineSkillsUsed,
        pluginsUsed: inlinePluginsUsed
      });
      abortedSettlement = createChatStreamSettlement(
        requestId,
        initialSettlementAnchorId,
        [userMessage],
        [],
        true
      );

      if (previousCount === 0) {
        queueFirstMessageTitle(db, _event.sender, requestId, request.threadId, content, attachments);
      }

      const storedMessages = db.listMessages(request.threadId);
      const settlementAnchorId = initialSettlementAnchorId ?? storedMessages.at(-2)?.id;
      const messages = storedMessages.map(toModelHistoryMessage);
      const modelContent = modelContentForMessage(userMessage);
      const piSession = prepareThreadPiSession(db, userDataDir, request.threadId, cwd);

      const turn = await buildChatTurnContext(db, {
        threadId: request.threadId,
        providerId: request.providerId,
        modelId: request.modelId,
        memoryEnabled: request.memoryEnabled,
        skillIds: request.skillIds,
        queryText: content,
        inlineSkills,
        inlinePluginSkills,
        signal: abortController.signal
      });
      const trace = db.createToolRun({
        threadId: request.threadId,
        title: `${turn.runtimeProvider.providerName} chat completion`,
        providerId: turn.runtimeProvider.providerName,
        modelId: turn.runtimeProvider.modelId,
        inputSummary: summarizeInput(messages.length, attachments.length, turn.memoryUsed.length, turn.skillsUsed.length + inlineSkillsUsed.length + inlinePluginsUsed.length)
      });

      const reply = await runTracedGeneration(db, {
        request: {
          ...request,
          content: modelContent,
          cwd,
          messages,
          sessionManager: piSession.manager,
          sessionMessageIds: storedMessages.map((message) => message.id),
          currentMessageId: userMessage.id,
          onSessionEntriesLinked: sessionEntryLinker(db, request.threadId),
          packageExtensionPaths: inlinePluginSources,
          ...runtimeContextOptions(db, turn, request.threadId, _event.sender, working, requestId)
        },
        runtimeProvider: turn.runtimeProvider,
        traceId: trace.id,
        startedAt,
        requestId,
        threadId: request.threadId,
        signal: abortController.signal,
        sender: _event.sender,
        working
      });

      const persisted = shouldPersistRuntimeReply(reply)
        ? persistRuntimeGeneratedMessages(db, {
            threadId: request.threadId,
            runId: trace.id,
            reply,
            fallbackTimeline: reply.timeline,
            memoryUsed: turn.memoryUsed,
            skillsUsed: turn.skillsUsed,
            pluginsUsed: inlinePluginsUsed,
            webSearchUsed: reply.webSearchUsed,
            reasoningEffort: request.reasoningEffort
          })
        : null;
      if (reply.providerError) {
        finishTraceProviderFailure(db, {
          threadId: request.threadId,
          traceId: trace.id,
          startedAt,
          reply,
          fileChangesPersisted: Boolean(persisted)
        });
        settleChatStream({
          sender: _event.sender,
          requestId,
          threadId: request.threadId,
          status: "done",
          settlement: createChatStreamSettlement(requestId, settlementAnchorId, [userMessage], persisted?.messages ?? [], true)
        });
        throw new Error(reply.providerError);
      }
      if (!persisted) throw new Error("Provider completed without a persistable assistant response.");
      const assistantMessage = persisted.assistantMessage;
      finishTraceSuccess(db, trace.id, assistantMessage, reply);
      settleChatStream({
        sender: _event.sender,
        requestId,
        threadId: request.threadId,
        status: abortController.signal.aborted ? "aborted" : "done",
        settlement: createChatStreamSettlement(requestId, settlementAnchorId, [userMessage], persisted.messages, true)
      });
      working.finish(requestId, abortController.signal.aborted ? "cancelled" : "completed");
      return {
        userMessage,
        assistantMessage,
        content: assistantMessage.content,
        model: assistantMessage.modelId ?? reply.model,
        elapsedMs: assistantMessage.elapsedMs ?? reply.elapsedMs
      };
    } catch (error) {
      if (abortController.signal.aborted) {
        settleAbortedChatStream(_event.sender, requestId, request.threadId, abortedSettlement);
      }
      working.finish(requestId, abortController.signal.aborted ? "cancelled" : "failed");
      throw error;
    } finally {
      finishActiveRun(requestId);
    }
  });

  ipcMain.handle("chat:retry", async (_event, request: ChatRetryRequest): Promise<ChatRetryResponse> => {
    const db = context.getDatabase();
    request = chatRetryRequestSchema.parse(request);
    const requestId = request.requestId ?? `main-${crypto.randomUUID()}`;
    const abortController = new AbortController();
    if (!db.hasThread(request.threadId)) throw new Error("Thread does not exist.");
    const cwd = db.getThreadCwd(request.threadId);
    const startedAt = Date.now();
    const existingMessages = db.listMessages(request.threadId);
    const retryPlan = buildRetryPlan(existingMessages, request.messageId);
    const lastUserMessage = retryPlan.lastUserMessage;
    if (!lastUserMessage) throw new Error("No user message is available to retry.");
    const deleteFromIndex = retryPlan.deleteMessageIds.length > 0
      ? existingMessages.findIndex((message) => message.id === retryPlan.deleteMessageIds[0])
      : existingMessages.length;
    const settlementAnchorId = existingMessages[Math.max(0, deleteFromIndex) - 1]?.id;
    const settlementReplaceFromId = retryPlan.deleteMessageIds[0];
    const abortedSettlement = createChatStreamSettlement(
      requestId,
      settlementAnchorId,
      [],
      existingMessages.slice(deleteFromIndex),
      false,
      settlementReplaceFromId
    );
    const modelContent = modelContentForMessage(lastUserMessage);
    activeRuns.set(requestId, createActiveRun(request.threadId, abortController, request.captureContextTaxonomy === true));
    working.start({ requestId, threadId: request.threadId, activity: WORKING_ACTIVITY.preparingRetry });

    try {
      const userDataDir = app.getPath("userData");
      const piSession = prepareThreadPiSession(db, userDataDir, request.threadId, cwd);
      const branchBeforePromptEntryId = branchParentForMessage(
        db,
        request.threadId,
        piSession.manager,
        existingMessages,
        lastUserMessage.id
      );
      const inlineSkillIds = skillReferenceIds(lastUserMessage.skillsUsed);
      const inlineSkills = await db.getSkillsForPrompt(inlineSkillIds);
      const inlinePluginSkills = await resolvePluginSkillsForPrompt({ userDataDir }, inlineSkillIds);
      const inlinePluginIds = pluginReferenceIds(lastUserMessage.pluginsUsed);
      const inlinePluginSources = await resolvePluginPackageRuntimeSources({ userDataDir }, inlinePluginIds);

      const turn = await buildChatTurnContext(db, {
        threadId: request.threadId,
        providerId: request.providerId,
        modelId: request.modelId,
        memoryEnabled: request.memoryEnabled,
        skillIds: request.skillIds,
        queryText: lastUserMessage.content,
        inlineSkills,
        inlinePluginSkills,
        signal: abortController.signal
      });
      const trace = db.createToolRun({
        threadId: request.threadId,
        title: `${turn.runtimeProvider.providerName} chat retry`,
        providerId: turn.runtimeProvider.providerName,
        modelId: turn.runtimeProvider.modelId,
        inputSummary: summarizeInput(retryPlan.contextMessages.length, lastUserMessage.attachments?.length ?? 0, turn.memoryUsed.length, turn.skillsUsed.length + (lastUserMessage.skillsUsed?.length ?? 0) + (lastUserMessage.pluginsUsed?.length ?? 0))
      });

      const reply = await runTracedGeneration(db, {
        request: {
          threadId: request.threadId,
          providerId: request.providerId,
          modelId: request.modelId,
          reasoningEffort: request.reasoningEffort,
          content: modelContent,
          cwd,
          attachments: lastUserMessage.attachments ?? [],
          toolsEnabled: request.toolsEnabled,
          captureContextTaxonomy: request.captureContextTaxonomy,
          messages: retryPlan.contextMessages,
          sessionManager: piSession.manager,
          sessionMessageIds: retryPlan.contextMessageIds,
          currentMessageId: lastUserMessage.id,
          branchBeforePromptEntryId,
          onSessionEntriesLinked: sessionEntryLinker(db, request.threadId),
          packageExtensionPaths: inlinePluginSources,
          ...runtimeContextOptions(db, turn, request.threadId, _event.sender, working, requestId)
        },
        runtimeProvider: turn.runtimeProvider,
        traceId: trace.id,
        startedAt,
        requestId,
        threadId: request.threadId,
        signal: abortController.signal,
        sender: _event.sender,
        working
      });

      // Delete the superseded turn and persist its replacement atomically so an
      // interrupted retry cannot drop messages without writing the new ones.
      const persisted = shouldPersistRuntimeReply(reply)
        ? db.runInTransaction(() => {
            db.deleteMessagesByIds(request.threadId, retryPlan.deleteMessageIds);
            return persistRuntimeGeneratedMessages(db, {
              threadId: request.threadId,
              runId: trace.id,
              reply,
              fallbackTimeline: reply.timeline,
              memoryUsed: turn.memoryUsed,
              skillsUsed: turn.skillsUsed,
              pluginsUsed: lastUserMessage.pluginsUsed ?? [],
              webSearchUsed: reply.webSearchUsed,
              reasoningEffort: request.reasoningEffort
            });
          })
        : null;
      if (reply.providerError) {
        finishTraceProviderFailure(db, {
          threadId: request.threadId,
          traceId: trace.id,
          startedAt,
          reply,
          fileChangesPersisted: Boolean(persisted)
        });
        if (persisted) {
          settleChatStream({
            sender: _event.sender,
            requestId,
            threadId: request.threadId,
            status: "done",
            settlement: createChatStreamSettlement(requestId, settlementAnchorId, [], persisted.messages, false, settlementReplaceFromId)
          });
        }
        throw new Error(reply.providerError);
      }
      if (!persisted) throw new Error("Provider completed without a persistable assistant response.");
      const assistantMessage = persisted.assistantMessage;
      finishTraceSuccess(db, trace.id, assistantMessage, reply);
      settleChatStream({
        sender: _event.sender,
        requestId,
        threadId: request.threadId,
        status: abortController.signal.aborted ? "aborted" : "done",
        settlement: createChatStreamSettlement(requestId, settlementAnchorId, [], persisted.messages, false, settlementReplaceFromId)
      });
      working.finish(requestId, abortController.signal.aborted ? "cancelled" : "completed");
      return {
        assistantMessage,
        content: assistantMessage.content,
        model: assistantMessage.modelId ?? reply.model,
        elapsedMs: assistantMessage.elapsedMs ?? reply.elapsedMs
      };
    } catch (error) {
      if (abortController.signal.aborted) {
        settleAbortedChatStream(_event.sender, requestId, request.threadId, abortedSettlement);
      }
      working.finish(requestId, abortController.signal.aborted ? "cancelled" : "failed");
      throw error;
    } finally {
      finishActiveRun(requestId);
    }
  });

  ipcMain.handle("chat:edit", async (_event, request: ChatEditRequest): Promise<ChatEditResponse> => {
    const db = context.getDatabase();
    request = chatEditRequestSchema.parse(request);
    const requestId = request.requestId ?? `main-${crypto.randomUUID()}`;
    const abortController = new AbortController();
    const content = request.content.trim();
    const attachments = request.attachments ?? [];
    if (!content && attachments.length === 0) throw new Error("Message content is empty.");
    if (!db.hasThread(request.threadId)) throw new Error("Thread does not exist.");
    const cwd = db.getThreadCwd(request.threadId);
    const startedAt = Date.now();
    const existingMessages = db.listMessages(request.threadId);
    const targetIndex = existingMessages.findIndex((message) => message.id === request.messageId && message.role === "user");
    if (targetIndex < 0) throw new Error("User message to edit does not exist.");
    const settlementAnchorId = existingMessages[targetIndex - 1]?.id;
    const settlementReplaceFromId = existingMessages[targetIndex].id;
    let abortedSettlement = createChatStreamSettlement(
      requestId,
      settlementAnchorId,
      existingMessages.slice(targetIndex),
      [],
      false,
      settlementReplaceFromId
    );
    activeRuns.set(requestId, createActiveRun(request.threadId, abortController, request.captureContextTaxonomy === true));
    working.start({ requestId, threadId: request.threadId, activity: WORKING_ACTIVITY.preparingEdit });

    try {
      const userDataDir = app.getPath("userData");
      const piSession = prepareThreadPiSession(db, userDataDir, request.threadId, cwd);
      const branchBeforePromptEntryId = branchParentForMessage(
        db,
        request.threadId,
        piSession.manager,
        existingMessages,
        request.messageId
      );
      const inlineSkillIds = request.inlineSkillIds ?? skillReferenceIds(existingMessages[targetIndex].skillsUsed);
      const inlinePluginIds = request.inlinePluginIds ?? pluginReferenceIds(existingMessages[targetIndex].pluginsUsed);
      db.updateThreadActivePlugins({ threadId: request.threadId, pluginIds: inlinePluginIds });
      const inlineSkills = inlineSkillIds.length > 0 ? await db.getSkillsForPrompt(inlineSkillIds) : [];
      const inlinePluginSkills = inlineSkillIds.length > 0 ? await resolvePluginSkillsForPrompt({ userDataDir }, inlineSkillIds) : [];
      const inlinePluginsUsed = request.inlinePluginIds
        ? await resolvePluginPackageReferences({ userDataDir }, inlinePluginIds)
        : existingMessages[targetIndex].pluginsUsed ?? [];
      const inlinePluginSources = await resolvePluginPackageRuntimeSources({ userDataDir }, inlinePluginIds);
      const inlineSkillsUsed = request.inlineSkillIds
        ? toExplicitSkillReferences(mergeRuntimeSkills(inlineSkills, inlinePluginSkills))
        : existingMessages[targetIndex].skillsUsed ?? [];
      // Truncating the tail and rewriting the edited message must land together,
      // otherwise a crash between them corrupts the visible conversation.
      const userMessage = db.runInTransaction(() => {
        db.deleteMessagesByIds(request.threadId, existingMessages.slice(targetIndex + 1).map((message) => message.id));
        return db.updateMessage({
          threadId: request.threadId,
          messageId: request.messageId,
          content,
          attachments,
          skillsUsed: inlineSkillsUsed,
          pluginsUsed: inlinePluginsUsed
        });
      });
      abortedSettlement = createChatStreamSettlement(
        requestId,
        settlementAnchorId,
        [userMessage],
        [],
        false,
        settlementReplaceFromId
      );

      if (targetIndex === 0) {
        queueFirstMessageTitle(db, _event.sender, requestId, request.threadId, content, attachments);
      }

      const storedMessages = db.listMessages(request.threadId);
      const messages = storedMessages.map(toModelHistoryMessage);
      const modelContent = modelContentForMessage(userMessage);

      const turn = await buildChatTurnContext(db, {
        threadId: request.threadId,
        providerId: request.providerId,
        modelId: request.modelId,
        memoryEnabled: request.memoryEnabled,
        skillIds: request.skillIds,
        queryText: content,
        inlineSkills,
        inlinePluginSkills,
        signal: abortController.signal
      });
      const trace = db.createToolRun({
        threadId: request.threadId,
        title: `${turn.runtimeProvider.providerName} chat edit`,
        providerId: turn.runtimeProvider.providerName,
        modelId: turn.runtimeProvider.modelId,
        inputSummary: summarizeInput(messages.length, attachments.length, turn.memoryUsed.length, turn.skillsUsed.length + inlineSkillsUsed.length + inlinePluginsUsed.length)
      });

      const reply = await runTracedGeneration(db, {
        request: {
          threadId: request.threadId,
          providerId: request.providerId,
          modelId: request.modelId,
          reasoningEffort: request.reasoningEffort,
          content: modelContent,
          cwd,
          attachments,
          toolsEnabled: request.toolsEnabled,
          captureContextTaxonomy: request.captureContextTaxonomy,
          messages,
          sessionManager: piSession.manager,
          sessionMessageIds: storedMessages.map((message) => message.id),
          currentMessageId: userMessage.id,
          branchBeforePromptEntryId,
          onSessionEntriesLinked: sessionEntryLinker(db, request.threadId),
          packageExtensionPaths: inlinePluginSources,
          ...runtimeContextOptions(db, turn, request.threadId, _event.sender, working, requestId)
        },
        runtimeProvider: turn.runtimeProvider,
        traceId: trace.id,
        startedAt,
        requestId,
        threadId: request.threadId,
        signal: abortController.signal,
        sender: _event.sender,
        working
      });

      const persisted = shouldPersistRuntimeReply(reply)
        ? persistRuntimeGeneratedMessages(db, {
            threadId: request.threadId,
            runId: trace.id,
            reply,
            fallbackTimeline: reply.timeline,
            memoryUsed: turn.memoryUsed,
            skillsUsed: turn.skillsUsed,
            pluginsUsed: inlinePluginsUsed,
            webSearchUsed: reply.webSearchUsed,
            reasoningEffort: request.reasoningEffort
          })
        : null;
      if (reply.providerError) {
        finishTraceProviderFailure(db, {
          threadId: request.threadId,
          traceId: trace.id,
          startedAt,
          reply,
          fileChangesPersisted: Boolean(persisted)
        });
        settleChatStream({
          sender: _event.sender,
          requestId,
          threadId: request.threadId,
          status: "done",
          settlement: createChatStreamSettlement(requestId, settlementAnchorId, [userMessage], persisted?.messages ?? [], false, settlementReplaceFromId)
        });
        throw new Error(reply.providerError);
      }
      if (!persisted) throw new Error("Provider completed without a persistable assistant response.");
      const assistantMessage = persisted.assistantMessage;
      finishTraceSuccess(db, trace.id, assistantMessage, reply);
      settleChatStream({
        sender: _event.sender,
        requestId,
        threadId: request.threadId,
        status: abortController.signal.aborted ? "aborted" : "done",
        settlement: createChatStreamSettlement(requestId, settlementAnchorId, [userMessage], persisted.messages, false, settlementReplaceFromId)
      });
      working.finish(requestId, abortController.signal.aborted ? "cancelled" : "completed");
      return {
        userMessage,
        assistantMessage,
        content: assistantMessage.content,
        model: assistantMessage.modelId ?? reply.model,
        elapsedMs: assistantMessage.elapsedMs ?? reply.elapsedMs
      };
    } catch (error) {
      if (abortController.signal.aborted) {
        settleAbortedChatStream(_event.sender, requestId, request.threadId, abortedSettlement);
      }
      working.finish(requestId, abortController.signal.aborted ? "cancelled" : "failed");
      throw error;
    } finally {
      finishActiveRun(requestId);
    }
  });
}

function createActiveRun(threadId: string, abortController: AbortController, captureContextTaxonomy: boolean): ActiveRun {
  let resolveQueueReady: (controls: RuntimeQueueControls) => void = () => undefined;
  let rejectQueueReady: (error: Error) => void = () => undefined;
  const queueReady = new Promise<RuntimeQueueControls>((resolve, reject) => {
    resolveQueueReady = resolve;
    rejectQueueReady = reject;
  });
  queueReady.catch(() => undefined);
  return {
    threadId,
    abortController,
    captureContextTaxonomy,
    streamSettled: false,
    queueReady,
    resolveQueueReady,
    rejectQueueReady
  };
}

function activeQueueRun(requestId: string, threadId: string): ActiveRun {
  const run = activeRuns.get(requestId);
  if (!run || run.threadId !== threadId) {
    throw new Error("No active response is available for this queue request.");
  }
  return run;
}

function setActiveRunQueueControls(requestId: string, controls: RuntimeQueueControls): void {
  const run = activeRuns.get(requestId);
  if (!run) return;
  run.queueControls = controls;
  run.resolveQueueReady(controls);
}

function finishActiveRun(requestId: string): void {
  const run = activeRuns.get(requestId);
  if (run && !run.queueControls) {
    run.rejectQueueReady(new Error("Response finished before queue controls became available."));
  }
  activeRuns.delete(requestId);
  streamSenders.get(requestId)?.finish();
  streamSenders.delete(requestId);
}

// Chat stream events fire from async callbacks and trailing throttle timers,
// which can outlive the renderer (e.g. quitting mid-stream). Sending to a
// destroyed WebContents throws an uncaught "Object has been destroyed" in the
// main process, so every late send must go through this guard.
function sendChatStream(sender: WebContents, payload: unknown): void {
  if (sender.isDestroyed()) return;
  sender.send("chat:stream", payload);
}

function emitQueueUpdate(
  sender: WebContents,
  requestId: string,
  threadId: string,
  queue: ChatQueueState
): void {
  if (!canEmitRunUpdate(requestId, threadId)) return;
  sendChatStream(sender, {
    requestId,
    threadId,
    status: "running",
    queue
  });
}

type StreamUpdate = {
  content: string;
  timeline: ChatTimelineItem[];
  liveMessages?: RuntimeGeneratedMessage[];
};

// Test hook: the destroyed-WebContents regression needs a wide throttle window
// to deterministically leave a trailing timer pending when the window closes.
const STREAM_THROTTLE_MS = Number(process.env.JASMINE_E2E_STREAM_THROTTLE_MS ?? "") || 45;
// Force a full snapshot at least this often so any renderer/main divergence in the
// delta stream self-heals within a bounded number of ticks.
const STREAM_SNAPSHOT_INTERVAL = 40;
type StreamSender = {
  send(update: StreamUpdate): void;
  finish(): void;
};

const streamSenders = new Map<string, StreamSender>();

function canEmitRunUpdate(requestId: string, threadId: string): boolean {
  const run = activeRuns.get(requestId);
  return Boolean(run && run.threadId === threadId && !run.streamSettled);
}

function streamMessagesFromUpdate(update: StreamUpdate): ChatStreamMessage[] {
  if (update.liveMessages && update.liveMessages.length > 0) {
    return update.liveMessages.map((message) => ({
      role: message.role,
      content: message.content,
      attachments: message.attachments,
      timeline: message.timeline
    }));
  }
  return [{ role: "assistant", content: update.content, timeline: update.timeline }];
}

// Coalesce high-frequency token updates so a fast stream does not flood the
// renderer with one re-render per token (leading edge keeps the first frame of
// each burst instant, the trailing timer always delivers the final state).
// Each flush sends only the delta since the previous event for this request; the
// first flush and every STREAM_SNAPSHOT_INTERVAL flushes send a full snapshot.
function createThrottledStreamSender(
  sender: WebContents,
  requestId: string,
  threadId: string,
  intervalMs = STREAM_THROTTLE_MS
): StreamSender {
  let pending: StreamUpdate | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastSentAt = 0;
  let lastSnapshot: ChatStreamMessage[] | null = null;
  let flushCount = 0;
  const flush = () => {
    if (!pending) return;
    const update = pending;
    pending = null;
    lastSentAt = Date.now();
    const current = streamMessagesFromUpdate(update);
    const wantSnapshot = lastSnapshot === null || flushCount % STREAM_SNAPSHOT_INTERVAL === 0;
    const delta = wantSnapshot ? null : computeStreamDelta(lastSnapshot as ChatStreamMessage[], current);
    flushCount += 1;
    lastSnapshot = current;
    if (delta) {
      // Nothing observable changed since the last flush; skip the IPC round trip.
      if (delta.messages.length === 0) return;
      sendChatStream(sender, {
        requestId,
        threadId,
        status: "running",
        delta
      });
    } else {
      sendChatStream(sender, {
        requestId,
        threadId,
        status: "running",
        liveMessages: current
      });
    }
  };
  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };
  return {
    send(update: StreamUpdate) {
      pending = update;
      const elapsed = Date.now() - lastSentAt;
      if (elapsed >= intervalMs) {
        clearTimer();
        flush();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, intervalMs - elapsed);
      }
    },
    finish() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
    }
  };
}

function emitStreamUpdate(
  sender: WebContents,
  requestId: string,
  threadId: string,
  update: StreamUpdate
): void {
  if (!canEmitRunUpdate(requestId, threadId)) return;
  let send = streamSenders.get(requestId);
  if (!send) {
    send = createThrottledStreamSender(sender, requestId, threadId);
    streamSenders.set(requestId, send);
  }
  send.send(update);
}

function settleChatStream(input: {
  sender: WebContents;
  requestId: string;
  threadId: string;
  status: "done" | "aborted";
  settlement: ChatStreamSettlement;
}): void {
  const run = activeRuns.get(input.requestId);
  if (!run || run.threadId !== input.threadId || run.streamSettled) return;
  // Mark settled before flushing so a late runtime callback cannot create a new
  // sender between the final running snapshot and the authoritative settlement.
  run.streamSettled = true;
  streamSenders.get(input.requestId)?.finish();
  streamSenders.delete(input.requestId);
  sendChatStream(input.sender, {
    requestId: input.requestId,
    threadId: input.threadId,
    status: input.status,
    settlement: input.settlement
  });
}

function settleAbortedChatStream(
  sender: WebContents,
  requestId: string,
  threadId: string,
  settlement: ChatStreamSettlement
): void {
  settleChatStream({
    sender,
    requestId,
    threadId,
    status: "aborted",
    // Preserve the operation-specific anchor and render identities computed
    // before the first await. A generic latest-page snapshot would discard any
    // already-loaded prefix beyond the database page cap and remount optimistic
    // rows when a stop lands before the first runtime chunk.
    settlement
  });
}

type PersistedRuntimeMessages = {
  assistantMessage: ChatMessage;
  messages: ChatMessage[];
};

function shouldPersistRuntimeReply(reply: AssistantReply): boolean {
  if (!reply.providerError) return true;
  return Boolean(reply.generatedMessages?.some((message) => message.role === "assistant"));
}

function persistRuntimeGeneratedMessages(
  db: JasmineDatabase,
  input: {
    threadId: string;
    runId: string;
    reply: AssistantReply;
    fallbackTimeline: ChatTimelineItem[];
    memoryUsed: MemoryReference[];
    skillsUsed: SkillReference[];
    pluginsUsed: PluginReference[];
    webSearchUsed: WebSearchResult[];
    reasoningEffort?: ReasoningEffort;
  }
): PersistedRuntimeMessages {
  const generated = input.reply.generatedMessages?.length
    ? input.reply.generatedMessages
    : [{
        role: "assistant" as const,
        content: input.reply.content,
        timeline: input.fallbackTimeline
      }];
  const lastAssistantIndex = generated.map((message) => message.role).lastIndexOf("assistant");
  // Multi-turn runs persist several rows (queued user turns + assistant turns);
  // commit them atomically so a crash mid-write cannot leave a half-saved run.
  return db.runInTransaction(() => {
    let lastAssistantMessage: ChatMessage | null = null;
    const assistantMessages: ChatMessage[] = [];
    const persistedMessages: ChatMessage[] = [];

    for (const [index, message] of generated.entries()) {
      if (message.role === "user") {
        persistedMessages.push(db.addMessage({
          threadId: input.threadId,
          runId: input.runId,
          role: "user",
          content: message.content,
          attachments: message.attachments ?? [],
          sessionEntryId: message.sessionEntryId
        }));
        continue;
      }

      const baseTimeline = withRunMetadata(message.timeline ?? [], input.reply.model, input.reasoningEffort);
      lastAssistantMessage = db.addMessage({
        threadId: input.threadId,
        runId: input.runId,
        role: "assistant",
        content: message.content,
        elapsedMs: index === lastAssistantIndex ? input.reply.elapsedMs : undefined,
        modelId: input.reply.model,
        status: "sent",
        memoryUsed: input.memoryUsed,
        skillsUsed: input.skillsUsed,
        pluginsUsed: input.pluginsUsed,
        webSearchUsed: input.webSearchUsed,
        timeline: baseTimeline,
        sessionEntryId: message.sessionEntryId
      });
      assistantMessages.push(lastAssistantMessage);
      persistedMessages.push(lastAssistantMessage);
    }

    if (!lastAssistantMessage) {
      lastAssistantMessage = db.addMessage({
        threadId: input.threadId,
        runId: input.runId,
        role: "assistant",
        content: input.reply.content,
        elapsedMs: input.reply.elapsedMs,
        modelId: input.reply.model,
        status: "sent",
        memoryUsed: input.memoryUsed,
        skillsUsed: input.skillsUsed,
        pluginsUsed: input.pluginsUsed,
        webSearchUsed: input.webSearchUsed,
        timeline: withRunMetadata(input.fallbackTimeline, input.reply.model, input.reasoningEffort)
      });
      assistantMessages.push(lastAssistantMessage);
      persistedMessages.push(lastAssistantMessage);
    }
    const taxonomy = input.reply.contextTaxonomies?.at(-1) ?? input.reply.contextTaxonomy;
    if (taxonomy) {
      // The capture extension tracks the active queued task without retaining
      // any earlier payload. Legacy/fallback captures have no scope and belong
      // to the last assistant produced by the run.
      const taskIndex = taxonomy.providerRequest?.taskIndex ?? Math.max(1, assistantMessages.length);
      const message = assistantMessages[Math.min(Math.max(0, taskIndex - 1), assistantMessages.length - 1)] ?? lastAssistantMessage;
      const latestTaxonomy: ContextTaxonomy = {
        ...taxonomy,
        providerRequest: {
          index: 1,
          count: 1,
          taskIndex,
          policy: "task-capture"
        }
      };
      if (message) db.addContextCapture({ threadId: input.threadId, messageId: message.id, runId: input.runId, taxonomy: latestTaxonomy });
    }
    persistFileChangeCaptures(db, {
      threadId: input.threadId,
      messageId: lastAssistantMessage.id,
      runId: input.runId,
      captures: input.reply.fileChangeCaptures ?? []
    });
    return { assistantMessage: lastAssistantMessage, messages: persistedMessages };
  });
}

function persistFileChangeCaptures(
  db: JasmineDatabase,
  input: { threadId: string; messageId?: string; runId: string; captures: FileChangeCaptureInput[] }
): void {
  for (const capture of input.captures) {
    if (capture.changes.length === 0 && capture.coverage.status === "complete" && capture.warnings.length === 0 && !capture.coverage.bashInvoked) continue;
    db.addFileChangeCapture({
      threadId: input.threadId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      runId: input.runId,
      capture
    });
  }
}

function persistFailedRunFileChanges(
  db: JasmineDatabase,
  input: {
    threadId: string;
    runId: string;
    captures: FileChangeCaptureInput[];
  }
): void {
  const captures = input.captures.filter((capture) => (
    capture.changes.length > 0 || capture.coverage.status !== "complete" || capture.warnings.length > 0 || capture.coverage.bashInvoked
  ));
  if (captures.length === 0) return;
  db.runInTransaction(() => persistFileChangeCaptures(db, {
    threadId: input.threadId,
    runId: input.runId,
    captures
  }));
}

function withRunMetadata(timeline: ChatTimelineItem[], model: string, reasoningEffort?: ReasoningEffort): ChatTimelineItem[] {
  const metadata: ChatTimelineItem[] = [];
  if (!timeline.some((item) => item.kind === "system" && item.title === "Model")) {
    metadata.push({ id: `run-model-${crypto.randomUUID()}`, kind: "system", title: "Model", text: model });
  }
  if (reasoningEffort && !timeline.some((item) => item.kind === "system" && item.title === "Thinking level")) {
    metadata.push({ id: `run-thinking-${crypto.randomUUID()}`, kind: "system", title: "Thinking level", text: reasoningEffort });
  }
  return metadata.length > 0 ? [...metadata, ...timeline] : timeline;
}

function sessionEntryLinker(db: JasmineDatabase, threadId: string) {
  return (links: Array<{ messageId: string; sessionEntryId: string }>) => {
    db.runInTransaction(() => {
      for (const link of links) {
        db.linkMessageSessionEntry(threadId, link.messageId, link.sessionEntryId);
      }
    });
  };
}

function toExplicitSkillReferences(skills: SkillRecord[]): SkillReference[] {
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions
  }));
}

type ChatTurnContext = Awaited<ReturnType<typeof buildChatTurnContext>>;

// Shared context assembly for send/retry/edit: provider, settings, memory,
// skill manifests, web search bootstrap, prompt templates, and the optional
// prefetched web search results.
async function buildChatTurnContext(
  db: JasmineDatabase,
  input: {
    threadId: string;
    providerId?: string;
    modelId?: string;
    memoryEnabled?: boolean;
    skillIds?: string[];
    queryText: string;
    inlineSkills: SkillRecord[];
    inlinePluginSkills: SkillRecord[];
    signal: AbortSignal;
  }
) {
  const userDataDir = app.getPath("userData");
  const runtimeProvider = getRuntimeProvider(db, input.providerId, input.modelId);
  const appSettings = db.getAppSettings();
  const memoryUsed = input.memoryEnabled ? db.findRelevantMemories(input.queryText) : [];
  const selectedSkills = await db.getSkillsForPrompt(input.skillIds);
  const skillManifests = await prepareSkillManifests(mergeRuntimeSkills(selectedSkills, input.inlineSkills, input.inlinePluginSkills), userDataDir);
  const availableSkillManifests = await prepareEnabledSkillManifests(await db.listAllSkills(), userDataDir);
  const packageSkillPaths = await resolveEnabledPackageSkillPaths({ userDataDir });
  const promptTemplatePaths = getPromptTemplatePaths(db, userDataDir);
  const thread = db.getThread(input.threadId);
  if (!thread) throw new Error("Thread does not exist.");
  const permissionProjectRoot = thread.projectId ? db.getProjectCwd(thread.projectId) : null;
  const skillsUsed = selectedSkills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description
  }));
  return {
    userDataDir,
    runtimeProvider,
    appSettings,
    memoryUsed,
    skillManifests,
    availableSkillPaths: availableSkillManifests.map((skill) => skill.skillFilePath),
    packageSkillPaths,
    promptTemplatePaths,
    permissionProjectRoot,
    skillsUsed
  };
}

// Runtime request fields shared by all three generation paths.
function runtimeContextOptions(
  db: JasmineDatabase,
  turn: ChatTurnContext,
  threadId: string,
  sender: WebContents,
  working: WorkingRegistry,
  requestId: string
) {
  return {
    memoryContext: turn.memoryUsed.map((memory) => memory.content),
    skillContext: turn.skillManifests,
    availableSkillPaths: turn.availableSkillPaths,
    packageSkillPaths: turn.packageSkillPaths,
    piAgentDir: getJasminePiAgentDir(turn.userDataDir),
    terminalShellPath: turn.appSettings.terminalShellPath,
    askUserQuestion: async (prompt: Omit<AskUserQuestionPrompt, "id">, signal?: AbortSignal) => {
      working.waitingForUser(requestId);
      const response = await askUserQuestionInRenderer(sender, prompt, signal);
      if (!signal?.aborted) working.resumed(requestId);
      return response;
    },
    permissionMode: turn.appSettings.permissionMode,
    fileChangeTrackingMode: turn.appSettings.fileChangeTrackingMode,
    permissionProjectRoot: turn.permissionProjectRoot,
    requestPermissionApproval: async (request: Readonly<PermissionApprovalRequest>, signal?: AbortSignal) => {
      working.waitingForUser(requestId);
      try {
        return await requestPermissionApprovalInRenderer(sender, {
          threadId,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          reason: request.reason,
          summary: sanitizePermissionDisplay(request.summary),
          cwd: sanitizePermissionDisplay(request.cwd, 4_000),
          projectRoot: request.projectRoot ? sanitizePermissionDisplay(request.projectRoot, 4_000) : null,
          ...(request.command ? { command: sanitizePermissionDisplay(request.command, 20_000) } : {}),
          ...(request.path ? { path: sanitizePermissionDisplay(request.path, 4_000) } : {}),
          ...(request.resolvedPath ? { resolvedPath: sanitizePermissionDisplay(request.resolvedPath, 4_000) } : {})
        }, signal);
      } finally {
        if (!signal?.aborted) working.resumed(requestId);
      }
    },
    promptTemplatePaths: turn.promptTemplatePaths
  };
}

async function runTracedGeneration(
  db: JasmineDatabase,
  input: {
    request: Parameters<typeof generateAssistantReply>[0];
    runtimeProvider: Parameters<typeof generateAssistantReply>[1];
    traceId: string;
    startedAt: number;
    requestId: string;
    threadId: string;
    signal: AbortSignal;
    sender: WebContents;
    working: WorkingRegistry;
  }
): Promise<AssistantReply> {
  const observedFileChanges: FileChangeCaptureInput[] = [];
  return delayChatGenerationForRegression(input.signal).then(() => generateAssistantReply(input.request, input.runtimeProvider, {
      signal: input.signal,
      onUpdate: (update) => {
        if (!canEmitRunUpdate(input.requestId, input.threadId)) return;
        emitStreamUpdate(input.sender, input.requestId, input.threadId, update);
        input.working.activity(input.requestId, activityFromTimeline(update.timeline));
      },
      onQueueReady: (controls) => setActiveRunQueueControls(input.requestId, controls),
      onQueueUpdate: (queue) => {
        if (!canEmitRunUpdate(input.requestId, input.threadId)) return;
        emitQueueUpdate(input.sender, input.requestId, input.threadId, queue);
        input.working.queue(input.requestId, queueCount(queue));
      },
      shouldCaptureContextTaxonomy: () => {
        const run = activeRuns.get(input.requestId);
        return Boolean(run && run.threadId === input.threadId && run.captureContextTaxonomy);
      },
      onFileChangeCapture: (capture) => observedFileChanges.push(capture)
    })).catch((error: unknown) => {
    db.finishToolRun({
      id: input.traceId,
      status: "error",
      error: nonSecretError(error),
      elapsedMs: Date.now() - input.startedAt
    });
    persistFailedRunFileChanges(db, {
      threadId: input.threadId,
      runId: input.traceId,
      captures: observedFileChanges
    });
    throw error;
  });
}

async function delayChatGenerationForRegression(signal: AbortSignal): Promise<void> {
  if (process.env.JASMINE_E2E_HARNESS !== "1") return;
  const delayMs = Number.parseInt(process.env.JASMINE_E2E_CHAT_GENERATION_DELAY_MS ?? "", 10);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const error = new Error("Response stopped before generation.");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(finish, Math.min(delayMs, 5_000));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function activityFromTimeline(timeline: ChatTimelineItem[]): WorkingActivity {
  const latest = timeline.at(-1);
  if (!latest) return WORKING_ACTIVITY.generating;
  if (latest.kind === "thinking") return WORKING_ACTIVITY.thinking;
  if (latest.kind === "tool_call") {
    const toolName = latest.toolName.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48);
    return toolName ? usingToolActivity(toolName) : WORKING_ACTIVITY.usingTool;
  }
  if (latest.kind === "tool_result") return latest.isError ? WORKING_ACTIVITY.toolError : WORKING_ACTIVITY.processingToolResult;
  if (latest.kind === "assistant_text") return WORKING_ACTIVITY.writing;
  return WORKING_ACTIVITY.generating;
}

function queueCount(queue: ChatQueueState): number {
  return queue.followUp.length + queue.steering.length;
}

function finishTraceSuccess(db: JasmineDatabase, traceId: string, assistantMessage: ChatMessage, reply: AssistantReply): void {
  db.finishToolRun({
    id: traceId,
    status: "success",
    messageId: assistantMessage.id,
    outputSummary: summarizeOutput(assistantMessage.content),
    elapsedMs: reply.elapsedMs
  });
}

function finishTraceProviderFailure(
  db: JasmineDatabase,
  input: {
    threadId: string;
    traceId: string;
    startedAt: number;
    reply: AssistantReply;
    fileChangesPersisted: boolean;
  }
): void {
  db.finishToolRun({
    id: input.traceId,
    status: "error",
    error: nonSecretError(new Error(input.reply.providerError || "Provider request failed.")),
    elapsedMs: Date.now() - input.startedAt
  });
  if (!input.fileChangesPersisted) {
    persistFailedRunFileChanges(db, {
      threadId: input.threadId,
      runId: input.traceId,
      captures: input.reply.fileChangeCaptures ?? []
    });
  }
}

// First user message in a thread: set an immediate fallback title, then
// asynchronously generate a better one and stream it to the renderer.
function queueFirstMessageTitle(
  db: JasmineDatabase,
  sender: WebContents,
  requestId: string,
  threadId: string,
  content: string,
  attachments: PickedPath[]
): void {
  const fallbackTitle = titleFromMessage(content || titleFromAttachments(attachments));
  db.updateThreadTitle(threadId, fallbackTitle);
  queueTitleGeneration(db, threadId, content, fallbackTitle, (title) => {
    const run = activeRuns.get(requestId);
    sendChatStream(sender, {
      requestId,
      threadId,
      status: run && run.threadId === threadId && !run.streamSettled ? "running" : "done",
      threadTitle: title
    });
  });
}

async function updateGeneratedThreadTitle(db: JasmineDatabase, threadId: string, content: string, fallback: string, onTitle?: (title: string) => void): Promise<void> {
  if (!content.trim()) {
    db.updateThreadTitle(threadId, fallback);
    onTitle?.(fallback);
    return;
  }
  const startedAt = Date.now();
  const settings = db.getAppSettings();
  const trace = db.createToolRun({
    threadId,
    title: "Automatic title",
    providerId: settings.toolModel.providerId,
    modelId: settings.toolModel.modelId,
    inputSummary: summarizeOutput(content)
  });
  try {
    const result = process.env.JASMINE_E2E_MOCK_AI === "1"
      ? { title: fallback, usedFallback: false }
      : await generateTitleWithProviderResult(
          getRuntimeProvider(db, settings.toolModel.providerId, settings.toolModel.modelId),
          content,
          fallback,
          settings.toolModel.reasoningEffort
        );
    const nextTitle = updateThreadTitleIfUnchanged(db, threadId, fallback, result.title || fallback);
    db.finishToolRun({
      id: trace.id,
      status: result.usedFallback ? "error" : "success",
      outputSummary: nextTitle,
      error: result.usedFallback ? `Title fallback: ${result.fallbackReason ?? "empty title"}${result.debugSummary ? `; ${result.debugSummary}` : ""}` : undefined,
      elapsedMs: Date.now() - startedAt
    });
    onTitle?.(nextTitle);
  } catch (error) {
    const nextTitle = updateThreadTitleIfUnchanged(db, threadId, fallback, fallback);
    db.finishToolRun({
      id: trace.id,
      status: "error",
      outputSummary: nextTitle,
      error: nonSecretError(error),
      elapsedMs: Date.now() - startedAt
    });
    onTitle?.(nextTitle);
  }
}

function queueTitleGeneration(db: JasmineDatabase, threadId: string, content: string, fallback: string, onTitle?: (title: string) => void): void {
  void Promise.resolve().then(() => updateGeneratedThreadTitle(db, threadId, content, fallback, onTitle));
}

function updateThreadTitleIfUnchanged(db: JasmineDatabase, threadId: string, expectedCurrentTitle: string, nextTitle: string): string {
  const current = db.getThread(threadId);
  if (!current) return nextTitle;
  if (current.title !== expectedCurrentTitle) return current.title;
  const title = db.updateThreadTitle(threadId, nextTitle).title;
  appendThreadSessionName(db, threadId, title);
  return title;
}
