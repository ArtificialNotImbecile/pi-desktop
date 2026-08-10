import { app, BrowserWindow } from "electron";
import type { AppUpdateState } from "../../shared/ipc.js";
import {
  AppUpdateService,
  FakeAppUpdater,
  type AppUpdaterAdapter
} from "./appUpdater.js";

let service = new AppUpdateService({
  updater: null,
  currentVersion: app.getVersion(),
  broadcast: () => undefined
});

export async function initializeAppUpdater(beforeInstall: () => void): Promise<AppUpdateService> {
  const updater = await resolveUpdater();
  service = new AppUpdateService({
    updater,
    currentVersion: app.getVersion(),
    beforeInstall,
    broadcast: broadcastUpdateState
  });
  return service;
}

export function getAppUpdater(): AppUpdateService {
  return service;
}

async function resolveUpdater(): Promise<AppUpdaterAdapter | null> {
  const fakeScenario = process.env.JASMINE_E2E_FAKE_UPDATER;
  if (fakeScenario) {
    const scenario = fakeScenario === "error" || fakeScenario === "up-to-date" ? fakeScenario : "available";
    return new FakeAppUpdater(scenario, process.env.JASMINE_E2E_FAKE_UPDATE_VERSION || "9.9.9");
  }
  if (!app.isPackaged || process.platform !== "win32") return null;

  try {
    const updaterModule = await import("electron-updater");
    const defaultExport = updaterModule.default as { autoUpdater?: AppUpdaterAdapter } | undefined;
    return (updaterModule.autoUpdater as AppUpdaterAdapter | undefined) ?? defaultExport?.autoUpdater ?? null;
  } catch (error) {
    console.warn("Failed to initialize Jasmine auto-update support:", error);
    return null;
  }
}

function broadcastUpdateState(state: AppUpdateState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("updater:changed", state);
  }
}
