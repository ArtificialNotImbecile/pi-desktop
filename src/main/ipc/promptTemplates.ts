import { app, ipcMain } from "electron";
import type { PromptTemplateRecord, PromptTemplateSource, PromptTemplateSourceCreateRequest } from "../../shared/ipc.js";
import { promptTemplateSourceCreateSchema, threadIdSchema } from "../../shared/schemas.js";
import { listPromptTemplates } from "../services/promptTemplates.js";
import type { IpcContext } from "./context.js";

export function registerPromptTemplateIpc(context: IpcContext): void {
  ipcMain.handle("promptTemplates:list", async (): Promise<PromptTemplateRecord[]> => {
    return listPromptTemplates(context.getDatabase(), app.getPath("userData"));
  });

  ipcMain.handle("promptTemplateSources:list", (): PromptTemplateSource[] => {
    return context.getDatabase().listPromptTemplateSources();
  });

  ipcMain.handle("promptTemplateSources:add", (_event, request: PromptTemplateSourceCreateRequest): PromptTemplateSource => {
    return context.getDatabase().addPromptTemplateSource(promptTemplateSourceCreateSchema.parse(request));
  });

  ipcMain.handle("promptTemplateSources:delete", (_event, sourceId: string): void => {
    context.getDatabase().deletePromptTemplateSource(threadIdSchema.parse(sourceId));
  });
}
