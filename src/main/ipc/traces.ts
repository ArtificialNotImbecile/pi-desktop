import { ipcMain } from "electron";
import type { ToolRun } from "../../shared/ipc.js";
import { threadIdSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";

export function registerTraceIpc(context: IpcContext): void {
  ipcMain.handle("traces:listForThread", async (_event, threadId: string): Promise<ToolRun[]> => {
    threadId = threadIdSchema.parse(threadId);
    const db = context.getDatabase();
    if (!db.hasThread(threadId)) throw new Error("Thread does not exist.");
    return db.listToolRunsForThread(threadId);
  });

  ipcMain.handle("traces:listForMessage", async (_event, messageId: string): Promise<ToolRun[]> => {
    messageId = threadIdSchema.parse(messageId);
    return context.getDatabase().listToolRunsForMessage(messageId);
  });

  ipcMain.handle("traces:get", async (_event, runId: string): Promise<ToolRun> => {
    runId = threadIdSchema.parse(runId);
    const run = context.getDatabase().getToolRun(runId);
    if (!run) throw new Error("Trace does not exist.");
    return run;
  });
}
