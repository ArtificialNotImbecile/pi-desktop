import { ipcMain } from "electron";
import type { LocalFileDescription } from "../../shared/ipc.js";
import { externalUrlSchema, localFileDescribeRequestSchema, localFilePathSchema } from "../../shared/schemas.js";
import { describeLocalFiles, openExternalUrl, openLocalPath, revealLocalPath } from "../services/localFiles.js";

/**
 * Actions the chat takes on paths and links an assistant answer produced. These
 * are reachable from ordinary message content, so each argument is validated
 * here rather than trusted from the renderer.
 */
export function registerFileIpc(): void {
  ipcMain.handle("files:describe", async (_event, paths: string[]): Promise<LocalFileDescription[]> => {
    return describeLocalFiles(localFileDescribeRequestSchema.parse(paths));
  });

  ipcMain.handle("files:openDefault", async (_event, filePath: string): Promise<void> => {
    await openLocalPath(localFilePathSchema.parse(filePath));
  });

  ipcMain.handle("files:reveal", async (_event, filePath: string): Promise<void> => {
    await revealLocalPath(localFilePathSchema.parse(filePath));
  });

  ipcMain.handle("shell:openExternal", async (_event, url: string): Promise<void> => {
    await openExternalUrl(externalUrlSchema.parse(url));
  });
}
