import { z } from "zod";
import { MAX_BRAND_LOGO_DATA_URL_LENGTH, MAX_BRAND_SUBTITLE_LENGTH, MAX_BRAND_TITLE_LENGTH, isSupportedBrandLogoDataUrl } from "./brand.js";
import { permissionModeSchema } from "./permissionSchemas.js";

export const threadCreateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  projectId: z.union([z.string().min(1), z.null()]).optional()
}).optional();

export const threadIdSchema = z.string().min(1);

export const contextCaptureIdSchema = z.string().uuid();
export const fileChangeIdSchema = z.string().uuid();

export const contextTaxonomyRawRequestSchema = z.object({
  captureId: contextCaptureIdSchema,
  offset: z.number().int().min(0).optional(),
  length: z.number().int().min(1).max(65_536).optional()
});

export const threadIdsSchema = z.array(threadIdSchema).min(1).max(10000);

export const threadRenameSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(80)
});

export const threadDraftUpdateSchema = z.object({
  threadId: z.string().min(1),
  content: z.string().max(20_000)
});

export const threadActivePluginsUpdateSchema = z.object({
  threadId: z.string().min(1),
  pluginIds: z.array(z.string().min(1)).max(6)
});

export const threadContextUsageRequestSchema = z.object({
  threadId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional()
});

export const projectCreateFromPathSchema = z.object({
  path: z.string().trim().min(1).max(1000)
});

export const projectRenameSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80)
});

export const projectRemoveSchema = z.object({
  id: z.string().min(1)
});

export const projectOpenInExplorerSchema = z.object({
  id: z.string().min(1)
});

export const messageListRequestSchema = z.union([
  threadIdSchema,
  z.object({
    threadId: z.string().min(1),
    limit: z.number().int().min(1).max(500).optional(),
    before: z.object({
      id: z.string().min(1),
      createdAt: z.string().min(1)
    }).optional()
  })
]);

export const pickedPathSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(["file", "folder"]),
  mediaType: z.string().optional(),
  isImage: z.boolean().optional(),
  previewDataUrl: z.string().optional()
});

export const fileSearchRequestSchema = z.object({
  query: z.string().max(200),
  cwd: z.string().min(1).optional(),
  projectId: z.union([z.string().min(1), z.null()]).optional(),
  limit: z.number().int().min(1).max(50).optional()
});

export const executablePickerKindSchema = z.enum(["editor", "terminal"]);

const timelineSystemItemSchema = z.object({
  id: z.string(),
  kind: z.literal("system"),
  title: z.string(),
  text: z.string(),
  customType: z.string().optional(),
  origin: z.literal("pi-extension").optional(),
  data: z.unknown().optional()
});

const chatTimelineItemSchema = z.union([
  z.object({
    id: z.string(),
    kind: z.literal("thinking"),
    text: z.string()
  }),
  z.object({
    id: z.string(),
    kind: z.literal("tool_call"),
    toolCallId: z.string().optional(),
    toolName: z.string(),
    title: z.string(),
    argumentsJson: z.string()
  }),
  z.object({
    id: z.string(),
    kind: z.literal("tool_result"),
    toolCallId: z.string().optional(),
    toolName: z.string(),
    title: z.string(),
    content: z.string(),
    isError: z.boolean().optional()
  }),
  z.object({
    id: z.string(),
    kind: z.literal("assistant_text"),
    text: z.string()
  }),
  timelineSystemItemSchema
]);

export const chatHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timeline: z.array(chatTimelineItemSchema).optional(),
  attachments: z.array(pickedPathSchema).optional()
});

export const chatSendRequestSchema = z.object({
  requestId: z.string().min(1).optional(),
  threadId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  memoryEnabled: z.boolean().optional(),
  toolsEnabled: z.boolean().optional(),
  captureContextTaxonomy: z.boolean().optional(),
  skillIds: z.array(z.string().min(1)).max(12).optional(),
  inlineSkillIds: z.array(z.string().min(1)).max(6).optional(),
  inlinePluginIds: z.array(z.string().min(1)).max(6).optional(),
  messages: z.array(chatHistoryMessageSchema),
  content: z.string(),
  attachments: z.array(pickedPathSchema).optional()
});

export const chatRetryRequestSchema = z.object({
  requestId: z.string().min(1).optional(),
  threadId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  memoryEnabled: z.boolean().optional(),
  toolsEnabled: z.boolean().optional(),
  captureContextTaxonomy: z.boolean().optional(),
  skillIds: z.array(z.string().min(1)).max(12).optional(),
  messageId: z.string().min(1).optional()
});

export const chatEditRequestSchema = z.object({
  requestId: z.string().min(1).optional(),
  threadId: z.string().min(1),
  messageId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  memoryEnabled: z.boolean().optional(),
  toolsEnabled: z.boolean().optional(),
  captureContextTaxonomy: z.boolean().optional(),
  skillIds: z.array(z.string().min(1)).max(12).optional(),
  inlineSkillIds: z.array(z.string().min(1)).max(6).optional(),
  inlinePluginIds: z.array(z.string().min(1)).max(6).optional(),
  content: z.string(),
  attachments: z.array(pickedPathSchema).optional()
});

export const chatQueueRequestSchema = z.object({
  requestId: z.string().min(1),
  threadId: z.string().min(1),
  mode: z.enum(["followUp", "steer"]),
  content: z.string(),
  attachments: z.array(pickedPathSchema).optional()
});

export const chatQueueUpdateRequestSchema = z.object({
  requestId: z.string().min(1),
  threadId: z.string().min(1),
  messageId: z.string().min(1),
  content: z.string(),
  attachments: z.array(pickedPathSchema).optional()
});

export const chatQueueDeleteRequestSchema = z.object({
  requestId: z.string().min(1),
  threadId: z.string().min(1),
  messageId: z.string().min(1)
});

export const chatQueueSteerRequestSchema = chatQueueDeleteRequestSchema;

export const chatContextTaxonomyCaptureUpdateRequestSchema = z.object({
  threadId: z.string().min(1),
  enabled: z.boolean()
});

export const askUserQuestionResponseSchema = z.object({
  id: z.string().min(1),
  answers: z.array(z.object({
    questionId: z.string().trim().min(1).max(120),
    question: z.string().trim().min(1).max(1200),
    answer: z.string().trim().min(1).max(4000),
    custom: z.boolean(),
    selectedIndex: z.number().int().positive().optional(),
    selectedOptionLabel: z.string().trim().min(1).max(400).optional()
  })).min(1).max(3)
});

export const modelCapabilitiesUpdateSchema = z.object({
  vision: z.boolean().optional(),
  imageOutput: z.boolean().optional(),
  toolCalling: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  embedding: z.boolean().optional()
});

export const providerUpdateSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKeyRef: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  enabled: z.boolean().optional()
});

export const providerModelUpdateSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  enabled: z.boolean().optional(),
  capabilities: modelCapabilitiesUpdateSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  providerOptionsJson: z.string().refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, "Provider options must be valid JSON.").optional()
});

export const memoryListSchema = z.object({
  includeArchived: z.boolean().optional()
}).optional();

export const memoryCreateSchema = z.object({
  content: z.string().trim().min(1),
  sourceMessageId: z.string().optional(),
  sourceThreadId: z.string().optional()
});

export const memoryUpdateSchema = z.object({
  id: z.string().min(1),
  content: z.string().trim().min(1)
});

export const memoryArchiveSchema = z.object({
  id: z.string().min(1),
  archived: z.boolean()
});

export const skillCreateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(1).max(180).optional(),
  instructions: z.string().trim().min(1).max(8000).optional(),
  enabled: z.boolean().optional()
});

export const skillUpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(1).max(180).optional(),
  instructions: z.string().trim().min(1).max(8000).optional(),
  enabled: z.boolean().optional()
});

export const skillSourceCreateSchema = z.object({
  path: z.string().trim().min(1).max(1000)
});

export const promptTemplateSourceCreateSchema = z.object({
  path: z.string().trim().min(1).max(1000)
});

export const pluginPackageSourceSchema = z.string()
  .trim()
  .min(1, "Package source is required.")
  .max(1000, "Package source is too long.")
  .refine((value) => !/[\0\r\n]/.test(value), "Package source cannot contain control characters.");

export const pluginPackageScopeSchema = z.enum(["user", "project"]);

export const pluginPackageInstallSchema = z.object({
  source: pluginPackageSourceSchema
});

export const pluginPackageOperationSchema = z.object({
  source: pluginPackageSourceSchema,
  scope: pluginPackageScopeSchema.optional()
});

export const pluginPackageEnableSchema = pluginPackageOperationSchema.extend({
  enabled: z.boolean()
});

export const reasoningEffortSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const hexColorSchema = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color.");

export const appSettingsUpdateSchema = z.object({
  toolModel: z.object({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    reasoningEffort: reasoningEffortSchema.optional()
  }).optional(),
  appearance: z.object({
    accent: hexColorSchema.optional(),
    surface: hexColorSchema.optional(),
    ink: hexColorSchema.optional(),
    success: hexColorSchema.optional(),
    danger: hexColorSchema.optional()
  }).optional(),
  brand: z.object({
    logoDataUrl: z.union([
      z.string()
        .max(MAX_BRAND_LOGO_DATA_URL_LENGTH)
        .refine(isSupportedBrandLogoDataUrl, "Use a supported image data URL."),
      z.null()
    ]).optional(),
    mainTitle: z.string().trim().min(1).max(MAX_BRAND_TITLE_LENGTH).optional(),
    subtitle: z.string().trim().max(MAX_BRAND_SUBTITLE_LENGTH).optional()
  }).optional(),
  language: z.enum(["en", "zh"]).optional(),
  workingNotifications: z.object({
    mode: z.enum(["background", "always", "never"]).optional(),
    includeDetails: z.boolean().optional()
  }).optional(),
  permissionMode: permissionModeSchema.optional(),
  fileChangeTrackingMode: z.enum(["managed-tools-only", "watcher"]).optional(),
  skillEditorPath: z.string().trim().max(1000).optional(),
  terminalShellPath: z.string().trim().max(1000).optional()
});

export const workingRequestIdSchema = z.string().trim().min(1).max(200);

export const workingViewUpdateSchema = z.object({
  threadId: z.union([z.string().trim().min(1).max(200), z.null()])
});

export const terminalStartSchema = z.object({
  cwd: z.string().trim().max(1000).optional(),
  projectId: z.union([z.string().min(1), z.null()]).optional(),
  threadId: threadIdSchema.optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(4).max(200).optional()
}).optional();

export const terminalInputSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string().max(20_000)
});

export const terminalStopSchema = z.object({
  sessionId: z.string().min(1)
});

export const terminalResizeSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(4).max(200)
});

export const clipboardTextSchema = z.string().max(1_000_000);

export const activitySettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  localOnly: z.boolean().optional(),
  captureWindowTitles: z.boolean().optional(),
  captureScreenshots: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(3650).optional()
});

export const activityObservationListSchema = z.object({
  query: z.string().optional()
}).optional();

export const activityObservationCreateSchema = z.object({
  note: z.string().trim().min(1)
});

export const windowActionSchema = z.enum(["minimize", "maximize", "close"]);

export const spotlightSearchSchema = z.object({
  query: z.string().max(200)
});

export const spotlightExecuteSchema = z.object({
  commandId: z.enum(["open-thread", "new-chat", "open-settings"]),
  threadId: z.string().min(1).optional(),
  projectId: z.union([z.string().min(1), z.null()]).optional(),
  section: z.string().min(1).max(40).optional()
});
