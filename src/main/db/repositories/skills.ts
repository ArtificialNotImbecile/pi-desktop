import { randomUUID } from "node:crypto";
import type { SkillRecord, SkillSource } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type SkillRow = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type SkillSourceRow = {
  id: string;
  path: string;
  created_at: string;
  updated_at: string;
};

type ExternalSkillStateRow = {
  id: string;
  enabled: number;
  updated_at: string;
};

const SKILL_COLUMNS = "id, name, description, instructions, enabled, created_at, updated_at";
const SKILL_SOURCE_COLUMNS = "id, path, created_at, updated_at";
const EXTERNAL_SKILL_STATE_COLUMNS = "id, enabled, updated_at";

export function listSkills(db: SqlDatabase): SkillRecord[] {
  return db
    .prepare(`SELECT ${SKILL_COLUMNS} FROM skills ORDER BY name ASC`)
    .all()
    .map((row) => mapSkill(row as SkillRow));
}

export function deleteSkill(db: SqlDatabase, skillId: string): void {
  db.prepare("DELETE FROM skills WHERE id = ?").run(skillId);
}

export function listSkillSources(db: SqlDatabase): SkillSource[] {
  return db
    .prepare(`SELECT ${SKILL_SOURCE_COLUMNS} FROM skill_sources ORDER BY path ASC`)
    .all()
    .map((row) => mapSkillSource(row as SkillSourceRow));
}

export function addSkillSource(db: SqlDatabase, input: { path: string }, timestamp: string): SkillSource {
  const normalizedPath = input.path.trim();
  if (!normalizedPath) throw new Error("Skill source path cannot be empty.");
  const existing = db.prepare(`SELECT ${SKILL_SOURCE_COLUMNS} FROM skill_sources WHERE path = ?`).get(normalizedPath) as SkillSourceRow | undefined;
  if (existing) return mapSkillSource(existing);

  const source: SkillSource = {
    id: randomUUID(),
    path: normalizedPath,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  db.prepare("INSERT INTO skill_sources (id, path, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(source.id, source.path, source.createdAt, source.updatedAt);
  return source;
}

export function deleteSkillSource(db: SqlDatabase, sourceId: string): void {
  db.prepare("DELETE FROM skill_sources WHERE id = ?").run(sourceId);
}

export function listExternalSkillStates(db: SqlDatabase): Map<string, boolean> {
  const rows = db
    .prepare(`SELECT ${EXTERNAL_SKILL_STATE_COLUMNS} FROM external_skill_states`)
    .all() as ExternalSkillStateRow[];
  return new Map(rows.map((row) => [row.id, row.enabled === 1]));
}

export function updateExternalSkillState(db: SqlDatabase, skillId: string, enabled: boolean, timestamp: string): void {
  db.prepare(
    "INSERT INTO external_skill_states (id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at"
  ).run(skillId, enabled ? 1 : 0, timestamp);
}

function mapSkill(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    enabled: row.enabled === 1,
    source: "local",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSkillSource(row: SkillSourceRow): SkillSource {
  return {
    id: row.id,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
