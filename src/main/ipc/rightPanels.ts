import { ipcMain } from "electron";
import type { ChatMessage, ContextTaxonomy, ThreadArtifactsResponse, ThreadContextTaxonomyResponse } from "../../shared/ipc.js";
import { withMissingContextTaxonomySegments } from "../agent/extensions/contextCapture/classifier.js";
import { threadIdSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";

// Right-panel data is derived from the newest slice of the thread instead of a
// full-thread load: artifacts older than the window are rarely relevant and the
// taxonomy pane only renders the most recent capture (plan Phase 5.3).
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
      taxonomies: context.getDatabase().listMessagesPage({ threadId, limit: RIGHT_PANEL_MESSAGE_WINDOW })
        .filter((message) => message.role === "assistant")
        .flatMap((message) => collectTaxonomies(message))
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

function collectTaxonomies(message: ChatMessage): ThreadContextTaxonomyResponse["taxonomies"] {
  return (message.timeline ?? []).flatMap((item) => {
    if (item.kind !== "system" || item.customType !== "context-taxonomy" || !isContextTaxonomy(item.data)) return [];
    return [{
      messageId: message.id,
      createdAt: message.createdAt,
      taxonomy: withMissingContextTaxonomySegments(item.data)
    }];
  });
}

function isContextTaxonomy(value: unknown): value is ContextTaxonomy {
  const record = value && typeof value === "object" ? value as Partial<ContextTaxonomy> : null;
  return Boolean(record?.capturedAt && record?.provider && record?.model && Array.isArray(record.items));
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
