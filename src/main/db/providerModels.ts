import type { AiProvider, ModelCapabilities, ProviderModelConfig, ProviderStatus } from "../../shared/ipc.js";

export type ProviderRow = {
  id: string;
  name: string;
  type: "openai-compatible";
  base_url: string;
  api_key_ref: string;
  models_json: string;
  default_model: string;
  enabled: number;
  status: ProviderStatus;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export function mapProvider(row: ProviderRow): AiProvider {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    apiKeyRef: row.api_key_ref,
    models: parseModelConfigs(row.models_json),
    defaultModel: row.default_model,
    enabled: row.enabled === 1,
    status: row.status,
    lastCheckedAt: row.last_checked_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function parseModelConfigs(value: string): ProviderModelConfig[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    if (parsed.every((item) => typeof item === "string")) return mergeModelConfigs([], parsed);
    return parsed
      .filter(isPartialModelConfig)
      .map((item) => ({
        ...defaultModelConfig(item.id),
        ...item,
        capabilities: {
          ...defaultModelConfig(item.id).capabilities,
          ...item.capabilities
        }
      }));
  } catch {
    return [];
  }
}

export function mergeModelConfigs(existing: ProviderModelConfig[], modelIds: string[], metadata: ProviderModelConfig[] = []): ProviderModelConfig[] {
  const existingById = new Map(existing.map((model) => [model.id, model]));
  const metadataById = new Map(metadata.map((model) => [model.id, model]));

  return modelIds.map((modelId) => {
    const fallback = defaultModelConfig(modelId);
    const detected = metadataById.get(modelId);
    const current = existingById.get(modelId);
    const detectedBase: ProviderModelConfig = {
      ...fallback,
      ...detected,
      id: modelId,
      capabilities: {
        ...fallback.capabilities,
        ...detected?.capabilities
      }
    };

    if (!current) return detectedBase;

    if (current.customized) {
      return {
        ...detectedBase,
        ...current,
        id: modelId,
        enabled: current.enabled,
        capabilities: {
          ...detectedBase.capabilities,
          ...current.capabilities
        },
        customized: true,
        metadataSource: detected?.metadataSource ?? current.metadataSource,
        metadataRefreshedAt: detected?.metadataRefreshedAt ?? current.metadataRefreshedAt
      };
    }

    return {
      ...detectedBase,
      enabled: current.enabled,
      providerOptionsJson: current.providerOptionsJson || detectedBase.providerOptionsJson,
      customized: false
    };
  });
}

export function defaultModelConfig(modelId: string): ProviderModelConfig {
  const isDeepSeekV4 = modelId.startsWith("deepseek-v4");
  const isKimiK2 = modelId.startsWith("kimi-k2");
  return {
    id: modelId,
    enabled: true,
    capabilities: defaultCapabilities(modelId),
    contextWindow: isDeepSeekV4 ? 1_000_000 : isKimiK2 ? 262_000 : 128_000,
    maxOutputTokens: isDeepSeekV4 ? 32_768 : isKimiK2 ? 262_000 : 8_192,
    providerOptionsJson: isKimiK2 ? JSON.stringify({ temperature: 1 }, null, 2) : "{}"
  };
}

function defaultCapabilities(modelId: string): ModelCapabilities {
  const isDeepSeekV4 = modelId.startsWith("deepseek-v4");
  const isKimiK2 = modelId.startsWith("kimi-k2");
  return {
    vision: isKimiK2,
    imageOutput: false,
    toolCalling: isDeepSeekV4 || isKimiK2,
    reasoning: isDeepSeekV4 || isKimiK2,
    embedding: false
  };
}

function isPartialModelConfig(item: unknown): item is ProviderModelConfig {
  if (!item || typeof item !== "object") return false;
  return typeof (item as { id?: unknown }).id === "string";
}
