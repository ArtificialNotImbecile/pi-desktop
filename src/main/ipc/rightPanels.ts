import { ipcMain } from "electron";
import type { ChatMessage, ContextTaxonomy, ContextTaxonomyDetailResponse, ContextTaxonomyRawRequest, ContextTaxonomyRawResponse, ThreadArtifactsResponse, ThreadContextTaxonomyResponse } from "../../shared/ipc.js";
import { providerPayloadToContextTaxonomy, withMissingContextTaxonomySegments } from "../agent/extensions/contextCapture/classifier.js";
import { contextCaptureIdSchema, contextTaxonomyRawRequestSchema, threadIdSchema } from "../../shared/schemas.js";
import type { StoredContextCapture } from "../db/repositories/contextCaptures.js";
import type { IpcContext } from "./context.js";

// Artifact data is derived from a bounded message window. Context captures live
// in their own compressed table and are fetched independently/lazily.
const RIGHT_PANEL_MESSAGE_WINDOW = 500;

export function registerRightPanelIpc(context: IpcContext): void {
  ipcMain.handle("thread:artifacts:list", (_event, threadId: string): ThreadArtifactsResponse => {
    threadId = threadIdSchema.parse(threadId);
    return {
      threadId,
      artifacts: collectArtifacts(context.getDatabase().listMessagesPage({ threadId, limit: RIGHT_PANEL_MESSAGE_WINDOW }))
    };
  });

  ipcMain.handle("thread:contextTaxonomy:list", (_event, threadId: string): ThreadContextTaxonomyResponse => {
    threadId = threadIdSchema.parse(threadId);
    return {
      threadId,
      captures: context.getDatabase().listLatestTaskContextCaptures(threadId)
    };
  });

  ipcMain.handle("thread:contextTaxonomy:get", (_event, captureId: string): ContextTaxonomyDetailResponse => {
    captureId = contextCaptureIdSchema.parse(captureId);
    const capture = context.getDatabase().getContextCapture(captureId);
    if (!capture) throw new Error("Context capture not found.");
    return { captureId, taxonomy: taxonomyFromCapture(capture) };
  });

  ipcMain.handle("thread:contextTaxonomy:raw", (_event, input: ContextTaxonomyRawRequest): ContextTaxonomyRawResponse => {
    const request = contextTaxonomyRawRequestSchema.parse(input);
    const capture = context.getDatabase().getContextCapture(request.captureId);
    if (!capture) throw new Error("Context capture not found.");
    const raw = capture.rawPayload ?? "";
    const offset = Math.min(request.offset ?? 0, raw.length);
    const length = request.length ?? 65_536;
    const text = raw.slice(offset, offset + length);
    return {
      captureId: request.captureId,
      state: capture.summary.rawState,
      offset,
      totalChars: capture.summary.rawCharCount,
      text,
      done: offset + text.length >= raw.length,
      sha256: capture.summary.rawSha256
    };
  });
}

function collectArtifacts(messages: ChatMessage[]): ThreadArtifactsResponse["artifacts"] {
  const artifacts: ThreadArtifactsResponse["artifacts"] = [];
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      artifacts.push({
        id: `${message.id}:attachment:${attachment.path}`,
        messageId: message.id,
        kind: attachment.isImage ? "image" : "file",
        title: attachment.name,
        description: attachment.path,
        path: attachment.path,
        createdAt: message.createdAt
      });
    }
    for (const result of message.webSearchUsed ?? []) {
      artifacts.push({
        id: `${message.id}:web:${result.url}`,
        messageId: message.id,
        kind: "web",
        title: result.title,
        description: result.snippet || result.url,
        url: result.url,
        createdAt: message.createdAt
      });
    }
    for (const item of message.timeline ?? []) {
      if (item.kind !== "tool_call") continue;
      const path = pathFromArguments(item.argumentsJson);
      if (!path || !["write", "edit"].includes(item.toolName)) continue;
      artifacts.push({
        id: `${message.id}:tool:${item.id}`,
        messageId: message.id,
        kind: "file",
        title: path.split(/[\\/]/).pop() || path,
        description: `${item.toolName} ${path}`,
        path,
        createdAt: message.createdAt
      });
    }
  }
  return dedupeArtifacts(artifacts);
}

function taxonomyFromCapture(capture: StoredContextCapture): ContextTaxonomy {
  const summary = capture.summary;
  let taxonomy: ContextTaxonomy | null = null;
  if (capture.rawPayload && summary.rawState === "complete") {
    try {
      taxonomy = providerPayloadToContextTaxonomy(JSON.parse(capture.rawPayload) as unknown, {
        provider: summary.provider,
        model: summary.model,
        capturedAt: summary.createdAt,
        source: summary.source
      });
    } catch {
      taxonomy = null;
    }
  }
  taxonomy ??= capture.metadata.fallbackTaxonomy ? withMissingContextTaxonomySegments(capture.metadata.fallbackTaxonomy) : {
    capturedAt: summary.createdAt,
    provider: summary.provider,
    model: summary.model,
    source: summary.source,
    assemblyReason: "no-capture",
    items: []
  };
  const { rawPayload: _rawPayload, ...withoutInlineRaw } = taxonomy;
  return {
    ...withoutInlineRaw,
    providerRequest: {
      index: summary.requestIndex,
      count: summary.requestCount,
      taskIndex: summary.taskIndex,
      policy: "task-capture"
    },
    payloadHash: summary.rawSha256 ?? taxonomy.payloadHash,
    payloadSchemaVersion: taxonomy.payloadSchemaVersion ?? summary.schemaVersion,
    rawState: summary.rawState,
    rawCharCount: summary.rawCharCount,
    rawByteCount: summary.rawByteCount,
    ...(capture.metadata.cacheMetrics ? { cacheMetrics: capture.metadata.cacheMetrics } : {}),
    ...(summary.reasoningValidation ? { reasoningValidation: summary.reasoningValidation } : {})
  };
}

function pathFromArguments(argumentsJson: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    const value = parsed.path ?? parsed.filePath ?? parsed.targetPath ?? parsed.filename;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function dedupeArtifacts(artifacts: ThreadArtifactsResponse["artifacts"]): ThreadArtifactsResponse["artifacts"] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = artifact.path ?? artifact.url ?? artifact.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
