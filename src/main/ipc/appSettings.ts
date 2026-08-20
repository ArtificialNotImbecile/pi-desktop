import { ipcMain } from "electron";
import type { AppSettings, AppSettingsUpdateRequest } from "../../shared/ipc.js";
import { appSettingsUpdateSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";

export function registerAppSettingsIpc(context: IpcContext): void {
  ipcMain.handle("appSettings:get", async (): Promise<AppSettings> => {
    await delayAppSettingsForRegression();
    return context.getDatabase().getAppSettings();
  });

  ipcMain.handle("appSettings:update", (_event, request: AppSettingsUpdateRequest): AppSettings => {
    const parsed = appSettingsUpdateSchema.parse(request);
    const rollbackShortcut = parsed.spotlightShortcut === undefined
      ? null
      : context.replaceSpotlightShortcut(parsed.spotlightShortcut);
    try {
      return context.getDatabase().updateAppSettings(parsed);
    } catch (error) {
      try {
        rollbackShortcut?.();
      } catch (rollbackError) {
        console.error("Failed to restore the previous Spotlight shortcut:", rollbackError);
      }
      throw error;
    }
  });
}

async function delayAppSettingsForRegression(): Promise<void> {
  const delayMs = Number.parseInt(process.env.JASMINE_E2E_APP_SETTINGS_DELAY_MS ?? "", 10);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 10_000)));
}
