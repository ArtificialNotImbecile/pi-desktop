import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { WorkspaceProject } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type ProjectRow = {
  id: string;
  name: string;
  root_path: string;
  root_key: string;
  thread_count?: number;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
};

export type NormalizedProjectRoot = {
  rootPath: string;
  rootKey: string;
  defaultName: string;
};

export function listProjects(db: SqlDatabase): WorkspaceProject[] {
  return db
    .prepare(`
      SELECT
        workspace_projects.id,
        workspace_projects.name,
        workspace_projects.root_path,
        workspace_projects.root_key,
        workspace_projects.created_at,
        workspace_projects.updated_at,
        workspace_projects.last_opened_at,
        COUNT(chat_threads.id) AS thread_count
      FROM workspace_projects
      LEFT JOIN chat_threads ON chat_threads.project_id = workspace_projects.id
      GROUP BY workspace_projects.id
      ORDER BY workspace_projects.last_opened_at DESC, workspace_projects.updated_at DESC
    `)
    .all()
    .map((row) => mapProject(row as ProjectRow));
}

export function getProject(db: SqlDatabase, projectId: string): WorkspaceProject | null {
  const row = db
    .prepare(`
      SELECT
        workspace_projects.id,
        workspace_projects.name,
        workspace_projects.root_path,
        workspace_projects.root_key,
        workspace_projects.created_at,
        workspace_projects.updated_at,
        workspace_projects.last_opened_at,
        COUNT(chat_threads.id) AS thread_count
      FROM workspace_projects
      LEFT JOIN chat_threads ON chat_threads.project_id = workspace_projects.id
      WHERE workspace_projects.id = ?
      GROUP BY workspace_projects.id
    `)
    .get(projectId) as ProjectRow | undefined;
  return row ? mapProject(row) : null;
}

export function getProjectByRootKey(db: SqlDatabase, rootKey: string): WorkspaceProject | null {
  const row = db
    .prepare(`
      SELECT
        workspace_projects.id,
        workspace_projects.name,
        workspace_projects.root_path,
        workspace_projects.root_key,
        workspace_projects.created_at,
        workspace_projects.updated_at,
        workspace_projects.last_opened_at,
        COUNT(chat_threads.id) AS thread_count
      FROM workspace_projects
      LEFT JOIN chat_threads ON chat_threads.project_id = workspace_projects.id
      WHERE workspace_projects.root_key = ?
      GROUP BY workspace_projects.id
    `)
    .get(rootKey) as ProjectRow | undefined;
  return row ? mapProject(row) : null;
}

export function openOrCreateProject(db: SqlDatabase, input: { rootPath: string; name?: string }, timestamp: string): WorkspaceProject {
  const normalized = normalizeProjectRoot(input.rootPath);
  const existing = getProjectByRootKey(db, normalized.rootKey);
  if (existing) {
    db.prepare("UPDATE workspace_projects SET last_opened_at = ? WHERE id = ?").run(timestamp, existing.id);
    return getProject(db, existing.id) ?? existing;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO workspace_projects (id, name, root_path, root_key, created_at, updated_at, last_opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name?.trim() || normalized.defaultName,
    normalized.rootPath,
    normalized.rootKey,
    timestamp,
    timestamp,
    timestamp
  );
  const project = getProject(db, id);
  if (!project) throw new Error("Project could not be created.");
  return project;
}

export function renameProject(db: SqlDatabase, projectId: string, name: string, timestamp: string): WorkspaceProject {
  db.prepare("UPDATE workspace_projects SET name = ?, updated_at = ? WHERE id = ?").run(name, timestamp, projectId);
  const project = getProject(db, projectId);
  if (!project) throw new Error("Project does not exist.");
  return project;
}

export function removeProject(db: SqlDatabase, projectId: string): void {
  db.prepare("UPDATE chat_threads SET project_id = NULL WHERE project_id = ?").run(projectId);
  db.prepare("DELETE FROM workspace_projects WHERE id = ?").run(projectId);
}

export function normalizeProjectRoot(rootPath: string): NormalizedProjectRoot {
  const expanded = rootPath.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  const rootPathValue = stripTrailingSeparator(resolved);
  return {
    rootPath: rootPathValue,
    rootKey: rootKeyForPath(rootPathValue),
    defaultName: path.basename(rootPathValue) || rootPathValue
  };
}

function rootKeyForPath(value: string): string {
  const normalized = stripTrailingSeparator(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stripTrailingSeparator(value: string): string {
  const parsed = path.parse(value);
  if (value === parsed.root) return value;
  return value.replace(/[\\/]+$/, "");
}

function mapProject(row: ProjectRow): WorkspaceProject {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    threadCount: Number(row.thread_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at
  };
}
