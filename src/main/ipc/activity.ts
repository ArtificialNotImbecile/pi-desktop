import { ipcMain } from "electron";
import type {
  ActivityObservation,
  ActivityObservationCreateRequest,
  ActivityObservationListRequest,
  ActivitySettings,
  ActivitySettingsUpdateRequest
} from "../../shared/ipc.js";
import {
  activityObservationCreateSchema,
  activityObservationListSchema,
  activitySettingsUpdateSchema
} from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";

export function registerActivityIpc(context: IpcContext): void {
  ipcMain.handle("activity:settings:get", (): ActivitySettings => {
    return context.getDatabase().getActivitySettings();
  });

  ipcMain.handle("activity:settings:update", (_event, request: ActivitySettingsUpdateRequest): ActivitySettings => {
    return context.getDatabase().updateActivitySettings(activitySettingsUpdateSchema.parse(request));
  });

  ipcMain.handle("activity:observations:list", (_event, request?: ActivityObservationListRequest): ActivityObservation[] => {
    return context.getDatabase().listActivityObservations(activityObservationListSchema.parse(request));
  });

  ipcMain.handle("activity:observations:createManual", (_event, request: ActivityObservationCreateRequest): ActivityObservation => {
    return context.getDatabase().createManualActivityObservation(activityObservationCreateSchema.parse(request));
  });
}
