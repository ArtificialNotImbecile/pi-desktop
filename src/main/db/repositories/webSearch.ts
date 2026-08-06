import type { WebSearchProvider, WebSearchSettings, WebSearchSettingsUpdateRequest } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type WebSearchSettingsRow = {
  id: string;
  enabled: number;
  provider: WebSearchProvider;
  max_results: number;
  timeout_ms: number;
  last_run_at: string | null;
  last_error: string | null;
  updated_at: string;
};

export function ensureWebSearchSettings(db: SqlDatabase, timestamp: string): void {
  const existing = db.prepare("SELECT 1 AS exists_flag FROM web_search_settings WHERE id = 'default'").get() as { exists_flag?: number };
  if (existing?.exists_flag === 1) return;
  db.prepare(
    "INSERT INTO web_search_settings (id, enabled, provider, max_results, timeout_ms, updated_at) VALUES ('default', 0, 'pi-web-access', 4, 7000, ?)"
  ).run(timestamp);
}

export function getWebSearchSettings(db: SqlDatabase): WebSearchSettings | null {
  const row = db
    .prepare("SELECT id, enabled, provider, max_results, timeout_ms, last_run_at, last_error, updated_at FROM web_search_settings WHERE id = 'default'")
    .get() as WebSearchSettingsRow | undefined;
  return row ? mapWebSearchSettings(row) : null;
}

export function updateWebSearchSettings(
  db: SqlDatabase,
  current: WebSearchSettings,
  input: WebSearchSettingsUpdateRequest,
  timestamp: string
): void {
  const next = {
    enabled: input.enabled ?? current.enabled,
    provider: input.provider ?? current.provider,
    maxResults: input.maxResults ?? current.maxResults,
    timeoutMs: input.timeoutMs ?? current.timeoutMs
  };

  db.prepare(
    "UPDATE web_search_settings SET enabled = ?, provider = ?, max_results = ?, timeout_ms = ?, last_error = ?, updated_at = ? WHERE id = 'default'"
  ).run(next.enabled ? 1 : 0, next.provider, next.maxResults, next.timeoutMs, null, timestamp);
}

export function updateWebSearchRun(db: SqlDatabase, input: { lastError?: string | null }, timestamp: string): void {
  db.prepare("UPDATE web_search_settings SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = 'default'")
    .run(timestamp, input.lastError ?? null, timestamp);
}

function mapWebSearchSettings(row: WebSearchSettingsRow): WebSearchSettings {
  return {
    enabled: row.enabled === 1,
    provider: row.provider,
    maxResults: Number(row.max_results ?? 4),
    timeoutMs: Number(row.timeout_ms ?? 7000),
    lastRunAt: row.last_run_at ?? undefined,
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at
  };
}
