import { ipcMain } from "electron";
import type { SkillCreateRequest, SkillOpenResponse, SkillRecord, SkillSource, SkillSourceCreateRequest, SkillUpdateRequest } from "../../shared/ipc.js";
import { skillCreateSchema, skillSourceCreateSchema, skillUpdateSchema, threadIdSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";

export function registerSkillIpc(context: IpcContext): void {
  ipcMain.handle("skills:list", async (): Promise<SkillRecord[]> => {
    return context.getDatabase().listAllSkills();
  });

  ipcMain.handle("skills:create", async (_event, request: SkillCreateRequest): Promise<SkillRecord> => {
    return context.getDatabase().createSkill(skillCreateSchema.parse(request));
  });

  ipcMain.handle("skills:update", async (_event, request: SkillUpdateRequest): Promise<SkillRecord> => {
    return context.getDatabase().updateSkill(skillUpdateSchema.parse(request));
  });

  ipcMain.handle("skills:delete", async (_event, skillId: string): Promise<void> => {
    await context.getDatabase().deleteSkill(threadIdSchema.parse(skillId));
  });

  ipcMain.handle("skills:open", async (_event, skillId: string): Promise<SkillOpenResponse> => {
    return context.getDatabase().openSkill(threadIdSchema.parse(skillId));
  });

  ipcMain.handle("skillSources:list", (): SkillSource[] => {
    return context.getDatabase().listSkillSources();
  });

  ipcMain.handle("skillSources:add", (_event, request: SkillSourceCreateRequest): SkillSource => {
    return context.getDatabase().addSkillSource(skillSourceCreateSchema.parse(request));
  });

  ipcMain.handle("skillSources:delete", (_event, sourceId: string): void => {
    context.getDatabase().deleteSkillSource(threadIdSchema.parse(sourceId));
  });
}
