import { app, ipcMain } from "electron";
import type {
  PluginPackageEnableRequest,
  PluginPackageInstallRequest,
  PluginPackageOperationRequest,
  PluginPackageRecord,
  PluginResolveResourcesResponse,
  SkillRecord
} from "../../shared/ipc.js";
import {
  pluginPackageEnableSchema,
  pluginPackageInstallSchema,
  pluginPackageOperationSchema
} from "../../shared/schemas.js";
import {
  bootstrapPiWebAccessPluginFromWebSearch,
  installPluginPackage,
  listPluginPackages,
  listPluginSkills,
  removePluginPackage,
  resolvePluginResources,
  setPluginPackageEnabled,
  updatePluginPackage
} from "../services/plugins.js";
import type { IpcContext } from "./context.js";

export function registerPluginIpc(context: IpcContext): void {
  ipcMain.handle("plugins:list", async (): Promise<PluginPackageRecord[]> => {
    const userDataDir = app.getPath("userData");
    await bootstrapPiWebAccessPluginFromWebSearch({
      userDataDir
    }, context.getDatabase().getWebSearchSettings());
    return listPluginPackages({
      userDataDir
    });
  });

  ipcMain.handle("plugins:listSkills", async (): Promise<SkillRecord[]> => {
    const userDataDir = app.getPath("userData");
    await bootstrapPiWebAccessPluginFromWebSearch({
      userDataDir
    }, context.getDatabase().getWebSearchSettings());
    return listPluginSkills({
      userDataDir
    });
  });

  ipcMain.handle("plugins:install", async (_event, request: PluginPackageInstallRequest): Promise<PluginPackageRecord[]> => {
    const parsed = pluginPackageInstallSchema.parse(request);
    return installPluginPackage({ userDataDir: app.getPath("userData") }, parsed.source);
  });

  ipcMain.handle("plugins:update", async (_event, request: PluginPackageOperationRequest): Promise<PluginPackageRecord[]> => {
    const parsed = pluginPackageOperationSchema.parse(request);
    return updatePluginPackage({ userDataDir: app.getPath("userData") }, parsed.source);
  });

  ipcMain.handle("plugins:remove", async (_event, request: PluginPackageOperationRequest): Promise<PluginPackageRecord[]> => {
    const parsed = pluginPackageOperationSchema.parse(request);
    return removePluginPackage({ userDataDir: app.getPath("userData") }, parsed.source, parsed.scope);
  });

  ipcMain.handle("plugins:setEnabled", async (_event, request: PluginPackageEnableRequest): Promise<PluginPackageRecord[]> => {
    const parsed = pluginPackageEnableSchema.parse(request);
    return setPluginPackageEnabled({ userDataDir: app.getPath("userData") }, parsed.source, parsed.enabled, parsed.scope);
  });

  ipcMain.handle("plugins:resolveResources", async (): Promise<PluginResolveResourcesResponse> => {
    return resolvePluginResources({ userDataDir: app.getPath("userData") });
  });
}
