import { ipcMain } from "electron";
import type { McpMarketplaceListRequest, McpMarketplaceServer, McpServerCreateRequest, McpServerRecord, McpServerUpdateRequest } from "../../shared/ipc.js";
import { mcpMarketplaceListSchema, mcpMarketplaceServerSchema, mcpServerCreateSchema, mcpServerUpdateSchema, threadIdSchema } from "../../shared/schemas.js";
import { listMcpMarketplace } from "../services/mcpMarketplace.js";
import type { IpcContext } from "./context.js";

export function registerMcpIpc(context: IpcContext): void {
  ipcMain.handle("mcp:marketplace:list", async (_event, request?: McpMarketplaceListRequest): Promise<McpMarketplaceServer[]> => {
    return listMcpMarketplace(mcpMarketplaceListSchema.parse(request));
  });

  ipcMain.handle("mcp:servers:list", (): McpServerRecord[] => {
    return context.getDatabase().listMcpServers();
  });

  ipcMain.handle("mcp:servers:install", (_event, server: McpMarketplaceServer): McpServerRecord => {
    return context.getDatabase().installMcpServer(mcpMarketplaceServerSchema.parse(server));
  });

  ipcMain.handle("mcp:servers:create", (_event, request: McpServerCreateRequest): McpServerRecord => {
    return context.getDatabase().createMcpServer(mcpServerCreateSchema.parse(request));
  });

  ipcMain.handle("mcp:servers:update", (_event, request: McpServerUpdateRequest): McpServerRecord => {
    return context.getDatabase().updateMcpServer(mcpServerUpdateSchema.parse(request));
  });

  ipcMain.handle("mcp:servers:delete", (_event, id: string): void => {
    context.getDatabase().deleteMcpServer(threadIdSchema.parse(id));
  });
}
