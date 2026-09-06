import { createHash } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ReasoningEffort } from "../../shared/ipc.js";
import type { RemoteModelConfig } from "../agent/extensions/piRemote/types.js";
import type { RuntimeProviderConfig } from "../agent/runtime.js";

/** The model a remote turn is pinned to once the host has the configuration for it. */
export type RemoteModelSelection = {
  providerId: string;
  modelId: string;
  /** Pi thinking level to apply for the turn; null leaves the model's default. */
  thinkingLevel: ReasoningEffort | null;
};

export type RemoteModelCredential = {
  type: "api_key";
  key: string;
};

export type RemoteModelPayload = {
  selection: RemoteModelSelection;
  /** `models.json` plus the portable defaults, in the shape `pi-remote config sync` sends. */
  config: RemoteModelConfig;
  /** The `auth.json` entry for the provider, sent through the separate credential import. */
  credential: RemoteModelCredential;
  /** Identifies this exact payload, so an unchanged model is not pushed to the host again. */
  fingerprint: string;
};

/**
 * Turns the provider Jasmine would run a local turn with into the files the
 * remote Pi needs to run the same turn: one custom provider in `models.json`
 * carrying exactly the selected model, the defaults that make it the session's
 * model, and the credential for it. The model definition is the one the local
 * agent registers, so contextWindow, thinking mapping, and compat flags match.
 */
export function buildRemoteModelPayload(
  provider: RuntimeProviderConfig,
  model: Model<"openai-completions">,
  reasoningEffort?: ReasoningEffort
): RemoteModelPayload {
  const thinkingLevel = model.reasoning && reasoningEffort ? reasoningEffort : null;
  const config: RemoteModelConfig = {
    models: {
      providers: {
        [provider.providerName]: {
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          models: [portableModelDefinition(model)]
        }
      }
    },
    settings: {
      defaultProvider: provider.providerName,
      defaultModel: model.id,
      ...(thinkingLevel ? { defaultThinkingLevel: thinkingLevel } : {})
    }
  };
  const credential: RemoteModelCredential = { type: "api_key", key: literalCredentialValue(provider.apiKey) };
  return {
    selection: { providerId: provider.providerName, modelId: model.id, thinkingLevel },
    config,
    credential,
    fingerprint: createHash("sha256").update(JSON.stringify({ config, credential })).digest("hex")
  };
}

/**
 * Only the fields Pi reads from a `models.json` model entry. Provider-level
 * facts (provider id, baseUrl, api) live on the provider entry, and anything
 * else the catalog model carries is not part of the file format.
 */
function portableModelDefinition(model: Model<"openai-completions">): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
    ...(model.compat ? { compat: model.compat } : {})
  };
}

/**
 * Pi resolves a stored key that starts with `$` as an environment variable and
 * one that starts with `!` as a shell command. A real key never starts with
 * either, but a key is a value the user typed, so it is escaped rather than
 * trusted to be well formed: `$$` and `$!` are Pi's literal escapes.
 */
export function literalCredentialValue(key: string): string {
  if (key.startsWith("$") || key.startsWith("!")) return `$${key}`;
  return key;
}
