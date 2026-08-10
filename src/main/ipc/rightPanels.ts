import { ipcMain } from "electron";
import type { ContextTaxonomy, ContextTaxonomyDetailResponse, ContextTaxonomyRawRequest, ContextTaxonomyRawResponse, ThreadArtifactDetailResponse, ThreadArtifactsResponse, ThreadContextTaxonomyResponse } from "../../shared/ipc.js";
import { providerPayloadToContextTaxonomy, withMissingContextTaxonomySegments } from "../agent/extensions/contextCapture/classifier.js";
import { contextCaptureIdSchema, contextTaxonomyRawRequestSchema, fileChangeIdSchema, threadIdSchema } from "../../shared/schemas.js";
import type { StoredContextCapture } from "../db/repositories/contextCaptures.js";
import type { IpcContext } from "./context.js";

export function registerRightPanelIpc(context: IpcContext): void {
  ipcMain.handle("thread:artifacts:list", (_event, threadId: string): ThreadArtifactsResponse => {
    threadId = threadIdSchema.parse(threadId);
    return {
      threadId,
      captures: context.getDatabase().listFileChangeCaptures(threadId)
    };
  });

  ipcMain.handle("thread:artifacts:detail", (_event, threadId: string, changeId: string): ThreadArtifactDetailResponse => {
    threadId = threadIdSchema.parse(threadId);
    changeId = fileChangeIdSchema.parse(changeId);
    const change = context.getDatabase().getFileChangeDetail(threadId, changeId);
    if (!change) throw new Error("File change not found.");
    return { change };
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
