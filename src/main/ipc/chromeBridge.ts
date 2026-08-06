import { app, ipcMain } from "electron";
import type { ChromeTakeoverRegisterRequest, ChromeTakeoverStatus } from "../../shared/ipc.js";
import { chromeTakeoverRegisterSchema } from "../../shared/schemas.js";
import type { ChromeTakeoverStatus as BridgeServiceStatus } from "../services/chromeBridge.js";
import { BUNDLED_CHROME_EXTENSION_ID, getChromeBridge } from "../services/chromeBridge.js";
import type { IpcContext } from "./context.js";

export function registerChromeBridgeIpc(context: IpcContext): void {
  ipcMain.handle("chromeBridge:status", async (): Promise<ChromeTakeoverStatus> => {
    const bridge = await getChromeBridge(app.getPath("userData"));
    return toChromeTakeoverStatus(bridge.status(), context.getDatabase().getAppSettings().chromeTakeover);
  });

  ipcMain.handle("chromeBridge:register", async (_event, request: ChromeTakeoverRegisterRequest): Promise<ChromeTakeoverStatus> => {
    const parsed = chromeTakeoverRegisterSchema.parse(request);
    const extensionId = parsed.extensionId ?? BUNDLED_CHROME_EXTENSION_ID;
    const bridge = await getChromeBridge(app.getPath("userData"));
    const serviceStatus = await bridge.registerNativeHost(extensionId);
    const settings = context.getDatabase().updateAppSettings({
      chromeTakeover: {
        enabled: true,
        extensionId
      }
    });
    return toChromeTakeoverStatus(serviceStatus, settings.chromeTakeover);
  });

  ipcMain.handle("chromeBridge:disable", async (): Promise<ChromeTakeoverStatus> => {
    const bridge = await getChromeBridge(app.getPath("userData"));
    const serviceStatus = await bridge.unregisterNativeHost();
    const settings = context.getDatabase().updateAppSettings({
      chromeTakeover: {
        enabled: false
      }
    });
    return toChromeTakeoverStatus(serviceStatus, settings.chromeTakeover);
  });
}

function toChromeTakeoverStatus(
  status: BridgeServiceStatus,
  settings: { enabled: boolean; extensionId: string | null }
): ChromeTakeoverStatus {
  return {
    ...status,
    enabled: settings.enabled,
    hostRegistered: status.hostRegistered || Boolean(settings.enabled && settings.extensionId),
    extensionId: settings.extensionId ?? status.extensionId
  };
}
