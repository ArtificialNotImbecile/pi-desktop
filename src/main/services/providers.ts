import { execFileSync } from "node:child_process";
import type {
  AiProvider,
  ProviderModelConfig,
  ProviderModelsResponse,
  ProviderModelUpdateRequest,
  ProviderTestResponse,
  ProviderUpdateRequest
} from "../../shared/ipc.js";
import { providerModelUpdateSchema, providerUpdateSchema } from "../../shared/schemas.js";
import type { RuntimeProviderConfig } from "../agent/runtime.js";
import type { JasmineDatabase } from "../db/database.js";

export function listProviders(db: JasmineDatabase): AiProvider[] {
  return db.listProviders().map(toClientProvider);
}

export function updateProvider(db: JasmineDatabase, request: ProviderUpdateRequest): AiProvider {
  const parsed = providerUpdateSchema.parse(request);
  return toClientProvider(db.updateProvider(parsed));
}

export function updateProviderModel(db: JasmineDatabase, request: ProviderModelUpdateRequest): AiProvider {
  const parsed = providerModelUpdateSchema.parse(request);
  return toClientProvider(db.updateProviderModel(parsed));
}

export function getRuntimeProvider(db: JasmineDatabase, providerId?: string, modelId?: string): RuntimeProviderConfig {
  const provider = db.getRuntimeProvider(providerId);
  if (!provider.enabled) {
    throw new Error(`${provider.name} is disabled.`);
  }

  const selectedModelId = modelId?.trim() || provider.defaultModel;
  const selectedModel = provider.models.find((model) => model.id === selectedModelId);
  if (!selectedModel) {
    throw new Error(`${selectedModelId} is not available for ${provider.name}.`);
  }
  if (!selectedModel.enabled) {
    throw new Error(`${selectedModelId} is disabled for ${provider.name}.`);
  }

  const apiKey = resolveApiKey(provider.apiKeyRef);
  if (!apiKey) {
    throw new Error(missingApiKeyMessage(provider.apiKeyRef));
  }

  return {
    providerName: provider.id,
    apiKey,
    baseUrl: provider.baseUrl,
    modelId: selectedModel.id,
    capabilities: selectedModel.capabilities,
    providerOptionsJson: selectedModel.providerOptionsJson,
    contextWindow: selectedModel.contextWindow,
    maxOutputTokens: selectedModel.maxOutputTokens
  };
}

export async function testProvider(db: JasmineDatabase, providerId: string): Promise<ProviderTestResponse> {
  const provider = db.getProvider(providerId);
  if (!provider) throw new Error("Provider does not exist.");

  const apiKey = resolveApiKey(provider.apiKeyRef);
  if (!apiKey) {
    const updated = db.updateProviderCheck(provider.id, {
      status: "missing_key",
      lastError: missingApiKeyMessage(provider.apiKeyRef)
    });
    return { provider: toClientProvider(updated), status: "missing_key" };
  }

  const startedAt = Date.now();
  try {
    const { generateAssistantReply } = await import("../agent/runtime.js");
    await generateAssistantReply(
      {
        threadId: "provider-test",
        content: "Reply with ok.",
        messages: [{ role: "user", content: "Reply with exactly: ok" }]
      },
      {
        providerName: provider.id,
        apiKey,
        baseUrl: provider.baseUrl,
        modelId: provider.defaultModel
      }
    );

    const updated = db.updateProviderCheck(provider.id, { status: "connected", lastError: null });
    return { provider: toClientProvider(updated), status: "connected", elapsedMs: Date.now() - startedAt };
  } catch (caught) {
    const updated = db.updateProviderCheck(provider.id, {
      status: "failed",
      lastError: caught instanceof Error ? caught.message : "Provider test failed."
    });
    return { provider: toClientProvider(updated), status: "failed", elapsedMs: Date.now() - startedAt };
  }
}

export async function fetchProviderModels(db: JasmineDatabase, providerId: string): Promise<ProviderModelsResponse> {
  const provider = db.getProvider(providerId);
  if (!provider) throw new Error("Provider does not exist.");

  if (process.env.JASMINE_E2E_MOCK_AI === "1") {
    const modelIds = process.env.JASMINE_E2E_MANY_MODELS === "1" && provider.id === "moonshot"
      ? Array.from({ length: 24 }, (_item, index) => `kimi-k2.${index + 1}`)
      : provider.id === "moonshot"
      ? ["kimi-k2.6", "moonshot-v1-32k"]
      : ["deepseek-v4-flash", "deepseek-v4-pro"];
    const updatedModels = db.updateProviderModels(provider.id, modelIds);
    const connected = db.updateProviderCheck(provider.id, { status: "connected", lastError: null });
    return { provider: toClientProvider({ ...connected, models: updatedModels.models, defaultModel: updatedModels.defaultModel }), models: updatedModels.models };
  }

  const apiKey = resolveApiKey(provider.apiKeyRef);
  if (!apiKey) {
    const updated = db.updateProviderCheck(provider.id, {
      status: "missing_key",
      lastError: missingApiKeyMessage(provider.apiKeyRef)
    });
    return { provider: toClientProvider(updated), models: updated.models };
  }

  const response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const message = `Model list request failed: ${response.status}${text ? ` ${text.slice(0, 180)}` : ""}`;
    const updated = db.updateProviderCheck(provider.id, { status: "failed", lastError: message });
    return { provider: toClientProvider(updated), models: updated.models };
  }

  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  const modelIds = Array.from(
    new Set((body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === "string" && id.length > 0))
  );

  if (modelIds.length === 0) {
    const updated = db.updateProviderCheck(provider.id, { status: "failed", lastError: "Provider returned no models." });
    return { provider: toClientProvider(updated), models: updated.models };
  }

  const gatewayConfigs = await getGatewayModelConfigs(provider.id, modelIds);
  const enriched = db.updateProviderModels(provider.id, modelIds, undefined, gatewayConfigs);
  const connected = db.updateProviderCheck(provider.id, { status: "connected", lastError: null });
  return { provider: toClientProvider({ ...connected, models: enriched.models, defaultModel: enriched.defaultModel }), models: enriched.models };
}

type GatewayModel = {
  id: string;
  context_window?: number;
  max_tokens?: number;
  tags?: string[];
  type?: string;
};

async function getGatewayModelConfigs(providerId: string, modelIds: string[]): Promise<ProviderModelConfig[] | undefined> {
  try {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { data?: GatewayModel[] };
    const byNativeId = new Map<string, GatewayModel>();
    const aliases = gatewayProviderAliases(providerId);
    for (const item of body.data ?? []) {
      const [gatewayProvider, nativeId] = item.id.split("/");
      if (aliases.includes(gatewayProvider) && nativeId) byNativeId.set(nativeId, item);
    }

    const metadataRefreshedAt = new Date().toISOString();
    return modelIds.map((modelId) => {
      const item = byNativeId.get(modelId);
      if (!item) return undefined;
      const tags = item.tags ?? [];
      return {
        id: modelId,
        enabled: true,
        capabilities: {
          vision: tags.includes("vision"),
          imageOutput: tags.includes("image-generation"),
          toolCalling: tags.includes("tool-use"),
          reasoning: tags.includes("reasoning"),
          embedding: item.type === "embedding" || tags.includes("embedding")
        },
        contextWindow: item.context_window ?? 128_000,
        maxOutputTokens: item.max_tokens ?? 8_192,
        providerOptionsJson: "{}",
        customized: false,
        metadataSource: "vercel-ai-gateway",
        metadataRefreshedAt
      };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  } catch {
    return undefined;
  }
}

function gatewayProviderAliases(providerId: string): string[] {
  if (providerId === "moonshot") return ["moonshot", "moonshotai"];
  return [providerId];
}

// The PowerShell fallback lookup costs ~200-500ms of synchronous main-process
// time per call. When the app is launched from Explorer (no inherited shell
// env), every send/title-generation used to pay it, so results — including
// misses — are cached. Editing a user env var mid-session needs an app restart
// either way for the rest of the process environment.
const USER_ENV_MISS_TTL_MS = 5 * 60_000;
const userEnvLookupCache = new Map<string, { value: string; expiresAt: number | null }>();

function resolveApiKey(apiKeyRef: string): string {
  const trimmed = apiKeyRef.trim();
  if (trimmed.startsWith("key:")) return trimmed.slice(4).trim();
  if (!trimmed.startsWith("env:")) return "";

  const envName = trimmed.slice(4).trim();
  if (!envName) return "";

  const fromProcess = process.env[envName]?.trim();
  if (fromProcess) return fromProcess;

  if (process.platform !== "win32") return "";

  const cached = userEnvLookupCache.get(envName);
  if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
    return cached.value;
  }

  let value = "";
  try {
    value = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${envName.replace(/'/g, "''")}','User')`],
      { encoding: "utf8", windowsHide: true }
    ).trim();
  } catch {
    value = "";
  }
  userEnvLookupCache.set(envName, {
    value,
    expiresAt: value ? null : Date.now() + USER_ENV_MISS_TTL_MS
  });
  return value;
}

function toClientProvider(provider: AiProvider): AiProvider {
  if (!provider.apiKeyRef.trim().startsWith("key:")) return provider;
  return {
    ...provider,
    apiKeyRef: `key:${maskSecret(provider.apiKeyRef.slice(4))}`
  };
}

function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return "••••";
  const suffix = trimmed.slice(-4);
  return `••••${suffix}`;
}

function missingApiKeyMessage(apiKeyRef: string): string {
  return apiKeyRef.trim().startsWith("key:")
    ? "Direct API key is not set."
    : `${apiKeyRef} is not set.`;
}
