import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiRemoteError } from "./errors.js";
import type { RemoteModelConfig } from "./types.js";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MODEL_SETTING_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const;

export async function loadLocalPiModelConfig(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")): Promise<RemoteModelConfig> {
  const models = await readJsonObject(path.join(agentDir, "models.json"), true);
  const localSettings = await readJsonObject(path.join(agentDir, "settings.json"), false);
  const settings: Record<string, string> = {};
  for (const key of MODEL_SETTING_KEYS) {
    const value = localSettings[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 256) settings[key] = value;
  }
  return { models, settings };
}

async function readJsonObject(filePath: string, required: boolean): Promise<Record<string, unknown>> {
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new PiRemoteError("local-model-config-missing", `Local Pi configuration file ${path.basename(filePath)} is unavailable.`, {
      phase: "config",
      safeDetails: { path: filePath },
      cause: error
    });
  }
  if (raw.length > MAX_CONFIG_BYTES) {
    throw new PiRemoteError("local-model-config-too-large", `Local Pi configuration file ${path.basename(filePath)} exceeds 2 MiB.`, {
      phase: "config",
      safeDetails: { path: filePath, size: raw.length }
    });
  }
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("configuration root must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new PiRemoteError("local-model-config-invalid", `Local Pi configuration file ${path.basename(filePath)} is invalid JSON.`, {
      phase: "config",
      safeDetails: { path: filePath },
      cause: error
    });
  }
}
