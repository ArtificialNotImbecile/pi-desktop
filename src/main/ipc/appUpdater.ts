import { ipcMain, shell } from "electron";
import type { AppUpdateState } from "../../shared/ipc.js";
import { RELEASES_PAGE_URL, getAppUpdater } from "../services/appUpdaterRuntime.js";

export function registerAppUpdaterIpc(): void {
  ipcMain.handle("updater:getState", (): AppUpdateState => getAppUpdater().getState());
  ipcMain.handle("updater:check", (): Promise<AppUpdateState> => getAppUpdater().checkForUpdates());
  ipcMain.handle("updater:download", (): Promise<AppUpdateState> => getAppUpdater().downloadUpdate());
  ipcMain.handle("updater:install", (): AppUpdateState => getAppUpdater().installUpdate());
  // The destination is fixed here rather than passed in, so the renderer cannot
  // turn this into a general "open any URL" capability.
  ipcMain.handle("updater:openDownloadPage", async (): Promise<AppUpdateState> => {
    const updater = getAppUpdater();
    try {
      await shell.openExternal(RELEASES_PAGE_URL);
      return updater.getState();
    } catch (error) {
      return updater.reportDownloadPageFailure(error, RELEASES_PAGE_URL);
    }
  });
}
