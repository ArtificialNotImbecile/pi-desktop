import { ipcMain } from "electron";
import type { AiProvider, ProviderModelUpdateRequest, ProviderModelsResponse, ProviderTestResponse, ProviderUpdateRequest } from "../../shared/ipc.js";
import { providerModelUpdateSchema, providerUpdateSchema, threadIdSchema } from "../../shared/schemas.js";
import { fetchProviderModels, listProviders, testProvider, updateProvider, updateProviderModel } from "../services/providers.js";
import type { IpcContext } from "./context.js";

export function registerProviderIpc(context: IpcContext): void {
  ipcMain.handle("providers:list", (): AiProvider[] => {
    return listProviders(context.getDatabase());
  });

  ipcMain.handle("providers:update", (_event, request: ProviderUpdateRequest): AiProvider => {
    return updateProvider(context.getDatabase(), providerUpdateSchema.parse(request));
  });

  ipcMain.handle("providers:test", (_event, providerId: string): Promise<ProviderTestResponse> => {
    return testProvider(context.getDatabase(), threadIdSchema.parse(providerId));
  });

  ipcMain.handle("providers:models", (_event, providerId: string): Promise<ProviderModelsResponse> => {
    return fetchProviderModels(context.getDatabase(), threadIdSchema.parse(providerId));
  });

  ipcMain.handle("providers:model:update", (_event, request: ProviderModelUpdateRequest): AiProvider => {
    return updateProviderModel(context.getDatabase(), providerModelUpdateSchema.parse(request));
  });
}
