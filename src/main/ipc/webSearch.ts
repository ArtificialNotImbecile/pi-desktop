import { app, ipcMain } from "electron";
import type { WebSearchSettings, WebSearchSettingsUpdateRequest } from "../../shared/ipc.js";
import { webSearchSettingsUpdateSchema } from "../../shared/schemas.js";
import { syncPiWebAccessPluginWithWebSearch } from "../services/plugins.js";
import { getWebSearchSettings, updateWebSearchSettings } from "../services/webSearch.js";
import type { IpcContext } from "./context.js";

export function registerWebSearchIpc(context: IpcContext): void {
  ipcMain.handle("webSearch:settings:get", (): WebSearchSettings => {
    return getWebSearchSettings(context.getDatabase());
  });

  ipcMain.handle("webSearch:settings:update", async (_event, request: WebSearchSettingsUpdateRequest): Promise<WebSearchSettings> => {
    const settings = updateWebSearchSettings(context.getDatabase(), webSearchSettingsUpdateSchema.parse(request));
    // Saving the toggle has to move the package right away. The chat turn also
    // syncs, but a user who saves and then opens Packages -- or restarts --
    // would otherwise see pi-web-access still reporting its previous state.
    await syncPiWebAccessPluginWithWebSearch({ userDataDir: app.getPath("userData") }, settings);
    return settings;
  });
}
