import { ipcMain } from "electron";
import type { WebSearchSettings, WebSearchSettingsUpdateRequest } from "../../shared/ipc.js";
import { webSearchSettingsUpdateSchema } from "../../shared/schemas.js";
import { getWebSearchSettings, updateWebSearchSettings } from "../services/webSearch.js";
import type { IpcContext } from "./context.js";

export function registerWebSearchIpc(context: IpcContext): void {
  ipcMain.handle("webSearch:settings:get", (): WebSearchSettings => {
    return getWebSearchSettings(context.getDatabase());
  });

  ipcMain.handle("webSearch:settings:update", (_event, request: WebSearchSettingsUpdateRequest): WebSearchSettings => {
    return updateWebSearchSettings(context.getDatabase(), webSearchSettingsUpdateSchema.parse(request));
  });
}
