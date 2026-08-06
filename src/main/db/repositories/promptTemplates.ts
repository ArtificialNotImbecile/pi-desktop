import { randomUUID } from "node:crypto";
import type { PromptTemplateSource } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type PromptTemplateSourceRow = {
  id: string;
  path: string;
  created_at: string;
  updated_at: string;
};

const PROMPT_TEMPLATE_SOURCE_COLUMNS = "id, path, created_at, updated_at";

export function listPromptTemplateSources(db: SqlDatabase): PromptTemplateSource[] {
  return db
    .prepare(`SELECT ${PROMPT_TEMPLATE_SOURCE_COLUMNS} FROM prompt_template_sources ORDER BY path ASC`)
    .all()
    .map((row) => mapPromptTemplateSource(row as PromptTemplateSourceRow));
}

export function addPromptTemplateSource(db: SqlDatabase, input: { path: string }, timestamp: string): PromptTemplateSource {
  const normalizedPath = input.path.trim();
  if (!normalizedPath) throw new Error("Prompt template source path cannot be empty.");
  const existing = db
    .prepare(`SELECT ${PROMPT_TEMPLATE_SOURCE_COLUMNS} FROM prompt_template_sources WHERE path = ?`)
    .get(normalizedPath) as PromptTemplateSourceRow | undefined;
  if (existing) return mapPromptTemplateSource(existing);

  const source: PromptTemplateSource = {
    id: randomUUID(),
    path: normalizedPath,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.prepare("INSERT INTO prompt_template_sources (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(source.id, source.path, source.createdAt, source.updatedAt);
  return source;
}

export function deletePromptTemplateSource(db: SqlDatabase, sourceId: string): void {
  db.prepare("DELETE FROM prompt_template_sources WHERE id = ?").run(sourceId);
}

function mapPromptTemplateSource(row: PromptTemplateSourceRow): PromptTemplateSource {
  return {
    id: row.id,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
