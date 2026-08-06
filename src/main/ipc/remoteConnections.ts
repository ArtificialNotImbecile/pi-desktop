import { ipcMain } from "electron";
import type {
  RemoteConnectionCreateRequest,
  RemoteConnectionImportResult,
  RemoteConnectionRecord,
  RemoteConnectionTestResult,
  RemoteConnectionUpdateRequest
} from "../../shared/ipc.js";
import { remoteConnectionCreateSchema, remoteConnectionUpdateSchema, threadIdSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";

export function registerRemoteConnectionIpc(context: IpcContext): void {
  ipcMain.handle("remoteConnections:list", (): RemoteConnectionRecord[] => {
    return context.getDatabase().listRemoteConnections();
  });

  ipcMain.handle("remoteConnections:import", async (): Promise<RemoteConnectionImportResult> => {
    return context.getDatabase().importRemoteConnections();
  });

  ipcMain.handle("remoteConnections:create", (_event, request: RemoteConnectionCreateRequest): RemoteConnectionRecord => {
    return context.getDatabase().createRemoteConnection(remoteConnectionCreateSchema.parse(request));
  });

  ipcMain.handle("remoteConnections:update", (_event, request: RemoteConnectionUpdateRequest): RemoteConnectionRecord => {
    return context.getDatabase().updateRemoteConnection(remoteConnectionUpdateSchema.parse(request));
  });

  ipcMain.handle("remoteConnections:delete", (_event, id: string): void => {
    context.getDatabase().deleteRemoteConnection(threadIdSchema.parse(id));
  });

  ipcMain.handle("remoteConnections:test", async (_event, id: string): Promise<RemoteConnectionTestResult> => {
    return context.getDatabase().testRemoteConnection(threadIdSchema.parse(id));
  });
}
