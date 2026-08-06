import type {
  AiProvider,
  ProviderModelConfig,
  ProviderModelUpdateRequest,
  ProviderStatus,
  ProviderUpdateRequest
} from "../../../shared/ipc.js";
import { mapProvider, mergeModelConfigs, type ProviderRow } from "../providerModels.js";
import type { SqlDatabase } from "./types.js";

const PROVIDER_COLUMNS = "id, name, type, base_url, api_key_ref, models_json, default_model, enabled, status, last_checked_at, last_error, created_at, updated_at";

export function listProviders(db: SqlDatabase): AiProvider[] {
  return db
    .prepare(`SELECT ${PROVIDER_COLUMNS} FROM providers ORDER BY name ASC`)
    .all()
    .map((row) => mapProvider(row as ProviderRow));
}

export function getProvider(db: SqlDatabase, providerId: string): AiProvider | null {
  const row = db
    .prepare(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id = ?`)
    .get(providerId) as ProviderRow | undefined;
  return row ? mapProvider(row) : null;
}

export function updateProvider(db: SqlDatabase, existing: AiProvider, input: ProviderUpdateRequest, timestamp: string): void {
  const apiKeyRef = input.apiKeyRef?.trim();
  const next = {
    baseUrl: input.baseUrl?.trim() || existing.baseUrl,
    apiKeyRef: apiKeyRef && !isMaskedDirectKeyRef(apiKeyRef) ? apiKeyRef : existing.apiKeyRef,
    defaultModel: input.defaultModel?.trim() || existing.defaultModel,
    enabled: input.enabled ?? existing.enabled
  };

  db.prepare(
    "UPDATE providers SET base_url = ?, api_key_ref = ?, default_model = ?, enabled = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?"
  ).run(next.baseUrl, next.apiKeyRef, next.defaultModel, next.enabled ? 1 : 0, "unchecked", null, timestamp, input.id);
}

function isMaskedDirectKeyRef(apiKeyRef: string): boolean {
  return apiKeyRef.startsWith("key:") && /^key:[•*]+.{0,4}$/.test(apiKeyRef);
}

export function updateProviderCheck(
  db: SqlDatabase,
  providerId: string,
  input: { status: ProviderStatus; lastError?: string | null },
  timestamp: string
): void {
  db.prepare("UPDATE providers SET status = ?, last_checked_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
    .run(input.status, timestamp, input.lastError ?? null, timestamp, providerId);
}

export function updateProviderModels(
  db: SqlDatabase,
  existing: AiProvider,
  modelIds: string[],
  defaultModel: string | undefined,
  metadata: ProviderModelConfig[] | undefined,
  timestamp: string
): void {
  const models = mergeModelConfigs(existing.models, modelIds, metadata);
  const nextDefault = defaultModel && modelIds.includes(defaultModel)
    ? defaultModel
    : modelIds.includes(existing.defaultModel)
      ? existing.defaultModel
      : modelIds[0] ?? existing.defaultModel;

  db.prepare("UPDATE providers SET models_json = ?, default_model = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(models), nextDefault, timestamp, existing.id);
}

export function updateProviderModel(db: SqlDatabase, existing: AiProvider, input: ProviderModelUpdateRequest, timestamp: string): void {
  const models = existing.models.map((model) => {
    if (model.id !== input.modelId) return model;
    return {
      ...model,
      enabled: input.enabled ?? model.enabled,
      capabilities: {
        ...model.capabilities,
        ...input.capabilities
      },
      contextWindow: input.contextWindow ?? model.contextWindow,
      maxOutputTokens: input.maxOutputTokens ?? model.maxOutputTokens,
      providerOptionsJson: input.providerOptionsJson ?? model.providerOptionsJson,
      customized: true
    };
  });

  db.prepare("UPDATE providers SET models_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(models), timestamp, input.providerId);
}
