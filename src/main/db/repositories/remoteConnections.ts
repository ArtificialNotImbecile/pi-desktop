import { randomUUID } from "node:crypto";
import type {
  RemoteConnectionCreateRequest,
  RemoteConnectionRecord,
  RemoteConnectionStatus,
  RemoteConnectionUpdateRequest
} from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type RemoteConnectionRow = {
  id: string;
  name: string;
  host: string;
  user: string | null;
  port: number | null;
  remote_path: string | null;
  config_host: string | null;
  config_path: string | null;
  source: "manual" | "vscode";
  active: number;
  status: RemoteConnectionStatus;
  last_connected_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

const REMOTE_COLUMNS = [
  "id",
  "name",
  "host",
  "user",
  "port",
  "remote_path",
  "config_host",
  "config_path",
  "source",
  "active",
  "status",
  "last_connected_at",
  "last_error",
  "created_at",
  "updated_at"
].join(", ");

export function listRemoteConnections(db: SqlDatabase): RemoteConnectionRecord[] {
  return db
    .prepare(`SELECT ${REMOTE_COLUMNS} FROM remote_connections ORDER BY active DESC, name ASC`)
    .all()
    .map((row) => mapRemoteConnection(row as RemoteConnectionRow));
}

export function getRemoteConnection(db: SqlDatabase, id: string): RemoteConnectionRecord | null {
  const row = db.prepare(`SELECT ${REMOTE_COLUMNS} FROM remote_connections WHERE id = ?`).get(id) as RemoteConnectionRow | undefined;
  return row ? mapRemoteConnection(row) : null;
}

export function getActiveRemoteConnection(db: SqlDatabase): RemoteConnectionRecord | null {
  const row = db.prepare(`SELECT ${REMOTE_COLUMNS} FROM remote_connections WHERE active = 1 ORDER BY updated_at DESC LIMIT 1`).get() as RemoteConnectionRow | undefined;
  return row ? mapRemoteConnection(row) : null;
}

export function upsertRemoteConnection(db: SqlDatabase, input: RemoteConnectionCreateRequest, timestamp: string): RemoteConnectionRecord {
  const normalized = normalizeCreate(input);
  const existing = findExisting(db, normalized);
  if (existing) {
    updateRemoteConnection(db, existing, {
      id: existing.id,
      name: normalized.name,
      host: normalized.host,
      user: normalized.user,
      port: normalized.port,
      remotePath: normalized.remotePath,
      configHost: normalized.configHost,
      configPath: normalized.configPath,
      active: normalized.active
    }, timestamp);
    const updated = getRemoteConnection(db, existing.id);
    if (!updated) throw new Error("Remote connection does not exist.");
    return updated;
  }
  return createRemoteConnection(db, normalized, timestamp);
}

export function createRemoteConnection(db: SqlDatabase, input: RemoteConnectionCreateRequest, timestamp: string): RemoteConnectionRecord {
  const connection = normalizeCreate(input);
  if (connection.active) clearActiveRemoteConnections(db);
  const record: RemoteConnectionRecord = {
    id: randomUUID(),
    ...connection,
    source: connection.source ?? "manual",
    active: connection.active ?? false,
    status: "unchecked",
    createdAt: timestamp,
    updatedAt: timestamp
  };

  db.prepare(
    `INSERT INTO remote_connections (
      id,
      name,
      host,
      user,
      port,
      remote_path,
      config_host,
      config_path,
      source,
      active,
      status,
      last_connected_at,
      last_error,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.name,
    record.host,
    record.user ?? null,
    record.port ?? null,
    record.remotePath ?? null,
    record.configHost ?? null,
    record.configPath ?? null,
    record.source,
    record.active ? 1 : 0,
    record.status,
    record.lastConnectedAt ?? null,
    record.lastError ?? null,
    record.createdAt,
    record.updatedAt
  );
  return record;
}

export function updateRemoteConnection(db: SqlDatabase, existing: RemoteConnectionRecord, input: RemoteConnectionUpdateRequest, timestamp: string): void {
  const active = input.active ?? existing.active;
  if (active) clearActiveRemoteConnections(db);
  const next = {
    name: input.name?.trim() || existing.name,
    host: input.host?.trim() || existing.host,
    user: input.user !== undefined ? input.user.trim() || undefined : existing.user,
    port: input.port === null ? undefined : input.port ?? existing.port,
    remotePath: input.remotePath !== undefined ? input.remotePath.trim() || undefined : existing.remotePath,
    configHost: input.configHost !== undefined ? input.configHost.trim() || undefined : existing.configHost,
    configPath: input.configPath !== undefined ? input.configPath.trim() || undefined : existing.configPath,
    active
  };
  if (!next.name || !next.host) throw new Error("Remote connection name and host are required.");
  db.prepare(
    `UPDATE remote_connections
      SET name = ?,
        host = ?,
        user = ?,
        port = ?,
        remote_path = ?,
        config_host = ?,
        config_path = ?,
        active = ?,
        updated_at = ?
      WHERE id = ?`
  ).run(
    next.name,
    next.host,
    next.user ?? null,
    next.port ?? null,
    next.remotePath ?? null,
    next.configHost ?? null,
    next.configPath ?? null,
    next.active ? 1 : 0,
    timestamp,
    existing.id
  );
}

export function updateRemoteConnectionStatus(
  db: SqlDatabase,
  id: string,
  input: { status: RemoteConnectionStatus; lastConnectedAt?: string | null; lastError?: string | null; remotePath?: string },
  timestamp: string
): void {
  db.prepare(
    `UPDATE remote_connections
      SET status = ?,
        last_connected_at = ?,
        last_error = ?,
        remote_path = COALESCE(?, remote_path),
        updated_at = ?
      WHERE id = ?`
  ).run(input.status, input.lastConnectedAt ?? null, input.lastError ?? null, input.remotePath ?? null, timestamp, id);
}

export function deleteRemoteConnection(db: SqlDatabase, id: string): void {
  db.prepare("DELETE FROM remote_connections WHERE id = ?").run(id);
}

function clearActiveRemoteConnections(db: SqlDatabase): void {
  db.prepare("UPDATE remote_connections SET active = 0 WHERE active = 1").run();
}

function findExisting(db: SqlDatabase, input: RemoteConnectionCreateRequest): RemoteConnectionRecord | null {
  const configPath = input.configPath?.trim();
  const configHost = input.configHost?.trim();
  if (configPath && configHost) {
    const row = db.prepare(`SELECT ${REMOTE_COLUMNS} FROM remote_connections WHERE config_path = ? AND config_host = ?`).get(configPath, configHost) as RemoteConnectionRow | undefined;
    if (row) return mapRemoteConnection(row);
  }
  const row = db
    .prepare(`SELECT ${REMOTE_COLUMNS} FROM remote_connections WHERE host = ? AND COALESCE(user, '') = ? AND COALESCE(port, 0) = ?`)
    .get(input.host.trim(), input.user?.trim() ?? "", input.port ?? 0) as RemoteConnectionRow | undefined;
  return row ? mapRemoteConnection(row) : null;
}

function normalizeCreate(input: RemoteConnectionCreateRequest): RemoteConnectionCreateRequest {
  const name = input.name.trim();
  const host = input.host.trim();
  if (!name || !host) throw new Error("Remote connection name and host are required.");
  return {
    name,
    host,
    user: input.user?.trim() || undefined,
    port: input.port,
    remotePath: input.remotePath?.trim() || undefined,
    configHost: input.configHost?.trim() || undefined,
    configPath: input.configPath?.trim() || undefined,
    source: input.source ?? "manual",
    active: input.active ?? false
  };
}

function mapRemoteConnection(row: RemoteConnectionRow): RemoteConnectionRecord {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    user: row.user ?? undefined,
    port: row.port ?? undefined,
    remotePath: row.remote_path ?? undefined,
    configHost: row.config_host ?? undefined,
    configPath: row.config_path ?? undefined,
    source: row.source === "vscode" ? "vscode" : "manual",
    active: row.active === 1,
    status: row.status === "connected" || row.status === "failed" ? row.status : "unchecked",
    lastConnectedAt: row.last_connected_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
