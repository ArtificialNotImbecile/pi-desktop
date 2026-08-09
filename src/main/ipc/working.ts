import { ipcMain } from "electron";
import type { WorkingSnapshot, WorkingViewUpdateRequest } from "../../shared/ipc.js";
import { workingRequestIdSchema, workingViewUpdateSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";

export function registerWorkingIpc(context: IpcContext): void {
  ipcMain.handle("working:snapshot", (): WorkingSnapshot => context.getWorkingRegistry().snapshot());
  ipcMain.handle("working:markRead", (_event, requestId: string): WorkingSnapshot =>
    context.getWorkingRegistry().markRead(workingRequestIdSchema.parse(requestId))
  );
  ipcMain.handle("working:clearCompleted", (): WorkingSnapshot => context.getWorkingRegistry().clearCompleted());
  ipcMain.handle("working:stop", (_event, requestId: string): boolean =>
    context.getWorkingRegistry().stop(workingRequestIdSchema.parse(requestId))
  );
  ipcMain.handle("working:view", (_event, request: WorkingViewUpdateRequest): void => {
    request = workingViewUpdateSchema.parse(request);
    context.getWorkingRegistry().viewThread(request.threadId);
  });
  ipcMain.handle("working:navigation:consume", () => context.consumePendingWorkingNavigation());
}
