import { app, ipcMain } from "electron";
import type { ChatMessage, ChatThread, MessageListRequest, ThreadActivePluginsUpdateRequest, ThreadCreateRequest, ThreadDraftUpdateRequest, ThreadRenameRequest } from "../../shared/ipc.js";
import { messageListRequestSchema, threadActivePluginsUpdateSchema, threadCreateSchema, threadDraftUpdateSchema, threadIdSchema, threadIdsSchema, threadRenameSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";
import { appendThreadSessionName, deleteOwnedPiSessionFile } from "../services/piSessions.js";

export function registerThreadIpc(context: IpcContext): void {
  ipcMain.handle("threads:list", (): ChatThread[] => {
    return context.getDatabase().listThreads();
  });

  ipcMain.handle("threads:create", (_event, input?: ThreadCreateRequest): ChatThread => {
    const parsed = threadCreateSchema.parse(input);
    return context.getDatabase().createThread(parsed?.title?.trim() || "New chat", parsed?.projectId ?? null);
  });

  ipcMain.handle("threads:rename", (_event, request: ThreadRenameRequest): ChatThread => {
    const parsed = threadRenameSchema.parse(request);
    const db = context.getDatabase();
    const thread = db.updateThreadTitle(parsed.id, parsed.title);
    appendThreadSessionName(db, parsed.id, thread.title);
    return thread;
  });

  ipcMain.handle("threads:delete", (_event, threadId: string): void => {
    const id = threadIdSchema.parse(threadId);
    const db = context.getDatabase();
    const sessionFile = db.getThreadSessionBinding(id)?.sessionFile;
    db.deleteThread(id);
    deleteOwnedPiSessionFile(app.getPath("userData"), sessionFile);
  });

  ipcMain.handle("threads:deleteMany", (_event, threadIds: string[]): void => {
    const ids = threadIdsSchema.parse(threadIds);
    const db = context.getDatabase();
    const sessionFiles = ids.map((id) => db.getThreadSessionBinding(id)?.sessionFile);
    db.deleteThreads(ids);
    for (const sessionFile of sessionFiles) deleteOwnedPiSessionFile(app.getPath("userData"), sessionFile);
  });

  ipcMain.handle("threads:draft:get", (_event, threadId: string): string => {
    return context.getDatabase().getThreadDraft(threadIdSchema.parse(threadId));
  });

  ipcMain.handle("threads:draft:update", (_event, request: ThreadDraftUpdateRequest): void => {
    context.getDatabase().updateThreadDraft(threadDraftUpdateSchema.parse(request));
  });

  ipcMain.handle("threads:plugins:update", (_event, request: ThreadActivePluginsUpdateRequest): ChatThread => {
    return context.getDatabase().updateThreadActivePlugins(threadActivePluginsUpdateSchema.parse(request));
  });

  ipcMain.handle("messages:list", (_event, request: string | MessageListRequest): ChatMessage[] => {
    const parsed = messageListRequestSchema.parse(request);
    if (typeof parsed === "string") {
      return context.getDatabase().listMessages(threadIdSchema.parse(parsed));
    }
    return context.getDatabase().listMessagesPage(parsed);
  });
}
