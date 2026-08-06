import { appendFileSync } from "node:fs";
import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import type { ProjectCreateFromPathRequest, ProjectOpenInExplorerRequest, ProjectRemoveRequest, ProjectRenameRequest, WorkspaceProject } from "../../shared/ipc.js";
import { projectCreateFromPathSchema, projectOpenInExplorerSchema, projectRemoveSchema, projectRenameSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";

export function registerProjectIpc(context: IpcContext): void {
  ipcMain.handle("projects:list", (): WorkspaceProject[] => {
    return context.getDatabase().listProjects();
  });

  ipcMain.handle("projects:openFolder", async (event): Promise<WorkspaceProject | null> => {
    const pickedPath = await pickProjectFolder(BrowserWindow.fromWebContents(event.sender));
    if (!pickedPath) return null;
    return context.getDatabase().createProjectFromPath(pickedPath);
  });

  ipcMain.handle("projects:createFromPath", (_event, request: ProjectCreateFromPathRequest): WorkspaceProject => {
    const parsed = projectCreateFromPathSchema.parse(request);
    return context.getDatabase().createProjectFromPath(parsed.path);
  });

  ipcMain.handle("projects:rename", (_event, request: ProjectRenameRequest): WorkspaceProject => {
    const parsed = projectRenameSchema.parse(request);
    return context.getDatabase().renameProject(parsed.id, parsed.name);
  });

  ipcMain.handle("projects:remove", (_event, request: ProjectRemoveRequest): void => {
    const parsed = projectRemoveSchema.parse(request);
    context.getDatabase().removeProject(parsed.id);
  });

  ipcMain.handle("projects:openInExplorer", async (_event, request: ProjectOpenInExplorerRequest): Promise<void> => {
    const parsed = projectOpenInExplorerSchema.parse(request);
    const project = context.getDatabase().getProject(parsed.id);
    if (!project) throw new Error("Project does not exist.");
    if (process.env.JASMINE_E2E_OPEN_EXPLORER_LOG) {
      appendFileSync(process.env.JASMINE_E2E_OPEN_EXPLORER_LOG, `${project.rootPath}\n`, "utf8");
      return;
    }
    const error = await shell.openPath(project.rootPath);
    if (error) throw new Error(error);
  });
}

export async function pickProjectFolder(owner?: BrowserWindow | null): Promise<string | null> {
  if (process.env.JASMINE_E2E_PICK_PROJECT_FOLDER) {
    return process.env.JASMINE_E2E_PICK_PROJECT_FOLDER;
  }

  const options: OpenDialogOptions = {
    title: "Open folder",
    properties: ["openDirectory"]
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
}
