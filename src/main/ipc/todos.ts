import { ipcMain } from "electron";
import type { TodoAddRequest, TodoOpenFileRequest, TodoOpenFileResponse, TodoSnapshot } from "../../shared/ipc.js";
import { todoAddSchema, todoOpenFileSchema } from "../../shared/schemas.js";
import { addTodo, getTodoSnapshot, openTodoFile } from "../services/todos.js";
import type { IpcContext } from "./context.js";

export function registerTodoIpc(context: IpcContext): void {
  ipcMain.handle("todos:snapshot", async (): Promise<TodoSnapshot> => {
    return getTodoSnapshot();
  });

  ipcMain.handle("todos:add", async (_event, request: TodoAddRequest): Promise<TodoSnapshot> => {
    const parsed = todoAddSchema.parse(request);
    const projects = context.getDatabase().listProjects();
    return addTodo(parsed, projects);
  });

  ipcMain.handle("todos:openFile", async (_event, request: TodoOpenFileRequest): Promise<TodoOpenFileResponse> => {
    const parsed = todoOpenFileSchema.parse(request);
    const database = context.getDatabase();
    return openTodoFile({
      kind: parsed.kind,
      currentEditorPath: database.getAppSettings().skillEditorPath,
      saveEditorPath: (editorPath) => {
        database.updateAppSettings({ skillEditorPath: editorPath });
      }
    });
  });
}
