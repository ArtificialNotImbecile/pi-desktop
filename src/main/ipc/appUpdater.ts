import { ipcMain } from "electron";
import type { AppUpdateState } from "../../shared/ipc.js";
import { getAppUpdater } from "../services/appUpdaterRuntime.js";

export function registerAppUpdaterIpc(): void {
  ipcMain.handle("updater:getState", (): AppUpdateState => getAppUpdater().getState());
  ipcMain.handle("updater:check", (): Promise<AppUpdateState> => getAppUpdater().checkForUpdates());
  ipcMain.handle("updater:download", (): Promise<AppUpdateState> => getAppUpdater().downloadUpdate());
  ipcMain.handle("updater:install", (): AppUpdateState => getAppUpdater().installUpdate());
}
