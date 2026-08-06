import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PromptTemplateRecord } from "../../shared/ipc.js";
import type { JasmineDatabase } from "../db/database.js";

export function getPromptTemplatePaths(db: JasmineDatabase, userData: string): string[] {
  const localPromptsDir = path.join(userData, "prompts");
  mkdirSync(localPromptsDir, { recursive: true });
  return Array.from(new Set([
    localPromptsDir,
    ...db.listPromptTemplateSources().map((source) => source.path)
  ]));
}

export async function listPromptTemplates(db: JasmineDatabase, userData: string): Promise<PromptTemplateRecord[]> {
  const { AuthStorage, createAgentSessionServices, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    authStorage,
    modelRegistry,
    resourceLoaderOptions: {
      additionalPromptTemplatePaths: getPromptTemplatePaths(db, userData),
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noContextFiles: true
    }
  });
  return services.resourceLoader.getPrompts().prompts
    .map((template) => ({
      name: template.name,
      description: template.description,
      argumentHint: template.argumentHint,
      filePath: template.filePath,
      sourceScope: template.sourceInfo?.scope
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath));
}
