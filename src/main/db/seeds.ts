import { mergeModelConfigs } from "./providerModels.js";
import type { SqlDatabase } from "./repositories/types.js";

export function seedDefaultProviders(db: SqlDatabase, timestamp: string): void {
  const seeds = [
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKeyRef: "env:DEEPSEEK_API_KEY",
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      defaultModel: "deepseek-v4-flash"
    },
    {
      id: "moonshot",
      name: "Moonshot Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKeyRef: "env:KIMI_API_KEY",
      models: ["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k3"],
      defaultModel: "kimi-k2.6"
    }
  ];

  for (const seed of seeds) {
    const existing = db.prepare("SELECT 1 AS exists_flag FROM providers WHERE id = ?").get(seed.id) as { exists_flag?: number };
    if (existing?.exists_flag === 1) continue;
    db.prepare(
      "INSERT INTO providers (id, name, type, base_url, api_key_ref, models_json, default_model, enabled, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      seed.id,
      seed.name,
      "openai-compatible",
      seed.baseUrl,
      seed.apiKeyRef,
      JSON.stringify(mergeModelConfigs([], seed.models)),
      seed.defaultModel,
      1,
      "unchecked",
      timestamp,
      timestamp
    );
  }
}

export function ensureDefaultActivitySettings(db: SqlDatabase, timestamp: string): void {
  const existing = db.prepare("SELECT 1 AS exists_flag FROM activity_settings WHERE id = 'default'").get() as { exists_flag?: number };
  if (existing?.exists_flag === 1) return;
  db.prepare(
    "INSERT INTO activity_settings (id, enabled, paused, local_only, capture_window_titles, capture_screenshots, retention_days, updated_at) VALUES ('default', 0, 0, 1, 0, 0, 30, ?)"
  ).run(timestamp);
}

export function seedDefaultSkills(db: SqlDatabase, timestamp: string): void {
  const row = db.prepare("SELECT COUNT(*) AS count FROM skills").get() as { count?: number };
  if (Number(row?.count ?? 0) > 0) return;

  const seeds = [
    {
      id: "skill-technical-writer",
      name: "Technical Writer",
      description: "Tightens explanations, examples, and docs for technical readers.",
      instructions: "When this skill is active, write with clear structure, concrete examples, and concise technical language. Call out assumptions and avoid vague filler."
    },
    {
      id: "skill-code-reviewer",
      name: "Code Reviewer",
      description: "Reviews code for bugs, regressions, tests, and maintainability.",
      instructions: "When this skill is active, prioritize concrete bugs, behavioral regressions, missing tests, and risky edge cases before style feedback."
    }
  ];

  for (const seed of seeds) {
    db.prepare("INSERT INTO skills (id, name, description, instructions, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      seed.id,
      seed.name,
      seed.description,
      seed.instructions,
      1,
      timestamp,
      timestamp
    );
  }
}
