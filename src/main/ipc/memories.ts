import { ipcMain } from "electron";
import type {
  MemoryArchiveRequest,
  MemoryCreateRequest,
  MemoryListRequest,
  MemoryRecord,
  MemoryUpdateRequest
} from "../../shared/ipc.js";
import { memoryArchiveSchema, memoryCreateSchema, memoryListSchema, memoryUpdateSchema, threadIdSchema } from "../../shared/schemas.js";
import type { IpcContext } from "./context.js";

export function registerMemoryIpc(context: IpcContext): void {
  ipcMain.handle("memories:list", (_event, request?: MemoryListRequest): MemoryRecord[] => {
    return context.getDatabase().listMemories(memoryListSchema.parse(request));
  });

  ipcMain.handle("memories:create", (_event, request: MemoryCreateRequest): MemoryRecord => {
    return context.getDatabase().createMemory(memoryCreateSchema.parse(request));
  });

  ipcMain.handle("memories:update", (_event, request: MemoryUpdateRequest): MemoryRecord => {
    return context.getDatabase().updateMemory(memoryUpdateSchema.parse(request));
  });

  ipcMain.handle("memories:archive", (_event, request: MemoryArchiveRequest): MemoryRecord => {
    return context.getDatabase().archiveMemory(memoryArchiveSchema.parse(request));
  });

  ipcMain.handle("memories:delete", (_event, memoryId: string): void => {
    context.getDatabase().deleteMemory(threadIdSchema.parse(memoryId));
  });
}
