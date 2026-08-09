import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { providerPayloadToContextTaxonomy, withContextCacheMetrics } from "./classifier.js";
import { validateReasoningRetention } from "./reasoningPolicy.js";
import type { ContextTaxonomy } from "./schema.js";

export { capContextTaxonomyForStorage, classifyTextSegments, contextCacheMetricsFromUsage, estimateTokens, previewText, providerPayloadToContextTaxonomy, safeStringify, sanitizePayload, taxonomyItem, withContextCacheMetrics } from "./classifier.js";
export { reasoningPolicyId, validateReasoningRetention } from "./reasoningPolicy.js";
export { CONTEXT_TAXONOMY_SCHEMA_VERSION } from "./schema.js";
export type { ContextCacheUsage, ContextCaptureMetadata } from "./classifier.js";
export type { ContextCacheMetrics, ContextPayloadShape, ContextProviderRequestScope, ContextRawPayloadState, ContextReasoningPolicyId, ContextReasoningValidation, ContextReasoningValidationBlock, ContextTaxonomy, ContextTaxonomyAssemblyReason, ContextTaxonomyItem, ContextTaxonomyKind, ContextTaxonomyPart, ContextTaxonomyPartKind, ContextTaxonomySegment } from "./schema.js";

export type ContextCaptureHandler = (taxonomy: ContextTaxonomy) => void | Promise<void>;

export type ContextCaptureExtensionOptions = {
  provider?: string;
  model?: string;
  currentUserPromptText?: string;
  getCanonicalMessages?(): unknown[] | undefined;
  outputDir?: string;
  onCapture?: ContextCaptureHandler;
  onError?(error: unknown, taxonomy?: ContextTaxonomy): void;
};

export function createContextCaptureExtension(options: ContextCaptureExtensionOptions = {}): ExtensionFactory {
  return async (pi) => {
    registerContextCapture(pi, options);
  };
}

export default function contextCaptureExtension(pi: ExtensionAPI): void {
  registerContextCapture(pi, defaultOptionsFromEnv());
}

export function defaultOptionsFromEnv(): ContextCaptureExtensionOptions {
  return {
    provider: process.env.PI_CONTEXT_CAPTURE_PROVIDER,
    model: process.env.PI_CONTEXT_CAPTURE_MODEL,
    outputDir: process.env.PI_CONTEXT_CAPTURE_DIR
  };
}

export function writeContextCaptureFile(taxonomy: ContextTaxonomy, outputDir = defaultOutputDir()): string {
  mkdirSync(outputDir, { recursive: true });
  const stamp = taxonomy.capturedAt.replace(/[:.]/g, "-");
  const fileName = `${stamp}-${taxonomy.payloadHash?.slice(0, 12) || "payload"}.json`;
  const targetPath = join(outputDir, fileName);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(taxonomy, null, 2), "utf8");
  renameSync(tempPath, targetPath);
  return targetPath;
}

function registerContextCapture(pi: Pick<ExtensionAPI, "on">, options: ContextCaptureExtensionOptions): void {
  let latestTaxonomy: ContextTaxonomy | null = null;
  let emittedLatestTaxonomy = false;

  pi.on("before_provider_request", (event) => {
    const payloadModel = payloadModelId(event.payload);
    latestTaxonomy = providerPayloadToContextTaxonomy(event.payload, {
      provider: options.provider || "unknown-provider",
      model: payloadModel || options.model || "unknown-model",
      currentUserPromptText: options.currentUserPromptText
    });
    let canonicalMessages: unknown[] | undefined;
    try {
      canonicalMessages = options.getCanonicalMessages?.();
    } catch {
      canonicalMessages = undefined;
    }
    latestTaxonomy.reasoningValidation = validateReasoningRetention({
      payload: event.payload,
      canonicalMessages,
      provider: latestTaxonomy.provider,
      model: latestTaxonomy.model
    });
    emittedLatestTaxonomy = false;
    return event.payload;
  });

  pi.on("message_end", (event) => {
    if (!latestTaxonomy || emittedLatestTaxonomy) return;
    const usage = assistantUsage(event.message);
    if (!usage) return;
    emitCapture(options, withContextCacheMetrics(latestTaxonomy, usage));
    emittedLatestTaxonomy = true;
    latestTaxonomy = null;
  });

  pi.on("agent_end", () => {
    if (!latestTaxonomy || emittedLatestTaxonomy) return;
    emitCapture(options, latestTaxonomy);
    emittedLatestTaxonomy = true;
    latestTaxonomy = null;
  });
}

function emitCapture(options: ContextCaptureExtensionOptions, taxonomy: ContextTaxonomy): void {
  try {
    const handler = options.onCapture ?? ((value: ContextTaxonomy) => {
      writeContextCaptureFile(value, options.outputDir || defaultOutputDir());
    });
    const result = handler(taxonomy);
    if (result && typeof result === "object" && "then" in result && typeof result.then === "function") {
      result.catch((error: unknown) => reportError(options, error, taxonomy));
    }
  } catch (error) {
    reportError(options, error, taxonomy);
  }
}

function reportError(options: ContextCaptureExtensionOptions, error: unknown, taxonomy?: ContextTaxonomy): void {
  if (options.onError) {
    options.onError(error, taxonomy);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[pi-context-capture] failed to persist capture: ${message}\n`);
}

function defaultOutputDir(): string {
  return join(process.cwd(), ".pi", "context-captures");
}

function payloadModelId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const model = (payload as Record<string, unknown>).model;
  return typeof model === "string" && model.trim() ? model : null;
}

function assistantUsage(message: unknown): { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; totalTokens?: unknown } | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return undefined;
  const usage = record.usage;
  return usage && typeof usage === "object" ? usage as Record<string, unknown> : undefined;
}
