import { randomUUID } from "node:crypto";
import type {
  RemoteSessionCacheState,
  RemoteSessionSummary,
  RemoteWorkspace,
  RemoteWorkspaceSource
} from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type WorkspaceRow = {
  id: string;
  profile_id: string;
  cwd: string;
  name: string;
  pinned: number;
  source: RemoteWorkspaceSource;
  created_at: string;
  updated_at: string;
  session_count?: number;
  latest_session_at?: string | null;
};

type SessionRow = {
  profile_id: string;
  session_id: string;
  cwd: string;
  name: string | null;
  preview: string | null;
  turn_count: number | null;
  remote_created_at: string;
  remote_updated_at: string | null;
  remote_size_bytes: number | null;
  header_fingerprint: string | null;
  cached_bytes: number;
  cached_fingerprint: string | null;
  transcript_path: string | null;
  synced_at: string | null;
  missing_since: string | null;
  listed_at: string;
};

export type RemoteSessionRecord = RemoteSessionSummary & {
  headerFingerprint: string | null;
  cachedFingerprint: string | null;
  transcriptPath: string | null;
  syncedAt: string | null;
};

export type RemoteSessionUpsert = {
  profileId: string;
  sessionId: string;
  cwd: string;
  name: string | null;
  preview: string | null;
  turnCount: number | null;
  remoteCreatedAt: string;
  remoteUpdatedAt: string | null;
  remoteSizeBytes: number | null;
  headerFingerprint: string | null;
};

export type RemoteSessionCacheUpdate = {
  profileId: string;
  sessionId: string;
  cachedBytes: number;
  cachedFingerprint: string | null;
  transcriptPath: string | null;
  syncedAt: string;
  remoteSizeBytes: number | null;
};

export function listRemoteWorkspaces(db: SqlDatabase, profileId?: string): RemoteWorkspace[] {
  const rows = db.prepare(`
    SELECT
      remote_workspaces.*,
      COUNT(remote_sessions.session_id) AS session_count,
      MAX(remote_sessions.remote_updated_at) AS latest_session_at
    FROM remote_workspaces
    LEFT JOIN remote_sessions
      ON remote_sessions.profile_id = remote_workspaces.profile_id
      AND remote_sessions.cwd = remote_workspaces.cwd
      AND remote_sessions.missing_since IS NULL
    ${profileId ? "WHERE remote_workspaces.profile_id = ?" : ""}
    GROUP BY remote_workspaces.id
    ORDER BY remote_workspaces.pinned DESC, latest_session_at DESC, remote_workspaces.name ASC
  `).all(...(profileId ? [profileId] : [])) as WorkspaceRow[];
  return rows.map(mapWorkspace);
}

export function getRemoteWorkspace(db: SqlDatabase, id: string): RemoteWorkspace | null {
  const row = db.prepare(`
    SELECT
      remote_workspaces.*,
      COUNT(remote_sessions.session_id) AS session_count,
      MAX(remote_sessions.remote_updated_at) AS latest_session_at
    FROM remote_workspaces
    LEFT JOIN remote_sessions
      ON remote_sessions.profile_id = remote_workspaces.profile_id
      AND remote_sessions.cwd = remote_workspaces.cwd
      AND remote_sessions.missing_since IS NULL
    WHERE remote_workspaces.id = ?
    GROUP BY remote_workspaces.id
  `).get(id) as WorkspaceRow | undefined;
  return row ? mapWorkspace(row) : null;
}

/**
 * Adds a workspace, or returns the existing one for that directory. A directory
 * discovered from session history and then added by hand becomes manual, so a
 * later reconciliation cannot quietly drop it.
 */
export function upsertRemoteWorkspace(
  db: SqlDatabase,
  input: { profileId: string; cwd: string; name?: string; source: RemoteWorkspaceSource },
  timestamp: string
): RemoteWorkspace {
  const existing = db
    .prepare("SELECT id, source FROM remote_workspaces WHERE profile_id = ? AND cwd = ?")
    .get(input.profileId, input.cwd) as { id: string; source: RemoteWorkspaceSource } | undefined;
  if (existing) {
    if (input.source === "manual" && existing.source !== "manual") {
      db.prepare("UPDATE remote_workspaces SET source = 'manual', updated_at = ? WHERE id = ?").run(timestamp, existing.id);
    }
    if (input.name) {
      db.prepare("UPDATE remote_workspaces SET name = ?, updated_at = ? WHERE id = ?").run(input.name, timestamp, existing.id);
    }
    const workspace = getRemoteWorkspace(db, existing.id);
    if (!workspace) throw new Error("Remote workspace could not be read back.");
    return workspace;
  }
  const id = randomUUID();
  db.prepare(`
    INSERT INTO remote_workspaces (id, profile_id, cwd, name, pinned, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `).run(id, input.profileId, input.cwd, input.name?.trim() || defaultWorkspaceName(input.cwd), input.source, timestamp, timestamp);
  const workspace = getRemoteWorkspace(db, id);
  if (!workspace) throw new Error("Remote workspace could not be created.");
  return workspace;
}

export function updateRemoteWorkspace(
  db: SqlDatabase,
  input: { id: string; name?: string; pinned?: boolean },
  timestamp: string
): RemoteWorkspace {
  const assignments: string[] = [];
  const values: Array<string | number> = [];
  if (input.name !== undefined) {
    assignments.push("name = ?");
    values.push(input.name);
  }
  if (input.pinned !== undefined) {
    assignments.push("pinned = ?");
    values.push(input.pinned ? 1 : 0);
  }
  if (assignments.length > 0) {
    assignments.push("updated_at = ?");
    values.push(timestamp);
    db.prepare(`UPDATE remote_workspaces SET ${assignments.join(", ")} WHERE id = ?`).run(...values, input.id);
  }
  const workspace = getRemoteWorkspace(db, input.id);
  if (!workspace) throw new Error("Remote workspace does not exist.");
  return workspace;
}

export function removeRemoteWorkspace(db: SqlDatabase, id: string): void {
  db.prepare("DELETE FROM remote_workspaces WHERE id = ?").run(id);
}

export function listRemoteSessions(db: SqlDatabase, profileId: string, cwd?: string): RemoteSessionRecord[] {
  const rows = db.prepare(`
    SELECT * FROM remote_sessions
    WHERE profile_id = ?${cwd ? " AND cwd = ?" : ""}
    ORDER BY COALESCE(remote_updated_at, remote_created_at) DESC
  `).all(...(cwd ? [profileId, cwd] : [profileId])) as SessionRow[];
  return rows.map(mapSession);
}

export function getRemoteSession(db: SqlDatabase, profileId: string, sessionId: string): RemoteSessionRecord | null {
  const row = db
    .prepare("SELECT * FROM remote_sessions WHERE profile_id = ? AND session_id = ?")
    .get(profileId, sessionId) as SessionRow | undefined;
  return row ? mapSession(row) : null;
}

/**
 * Writes what a listing reported. Cached bytes and the transcript path are
 * deliberately untouched: a listing says what the remote has, never what the
 * local copy holds.
 */
export function upsertRemoteSessions(db: SqlDatabase, sessions: RemoteSessionUpsert[], timestamp: string): void {
  const statement = db.prepare(`
    INSERT INTO remote_sessions (
      id, profile_id, session_id, cwd, name, preview, turn_count,
      remote_created_at, remote_updated_at, remote_size_bytes, header_fingerprint,
      cached_bytes, listed_at, missing_since
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)
    ON CONFLICT (profile_id, session_id) DO UPDATE SET
      cwd = excluded.cwd,
      name = excluded.name,
      preview = excluded.preview,
      turn_count = excluded.turn_count,
      remote_created_at = excluded.remote_created_at,
      remote_updated_at = excluded.remote_updated_at,
      remote_size_bytes = excluded.remote_size_bytes,
      header_fingerprint = excluded.header_fingerprint,
      listed_at = excluded.listed_at,
      missing_since = NULL
  `);
  for (const session of sessions) {
    statement.run(
      randomUUID(),
      session.profileId,
      session.sessionId,
      session.cwd,
      session.name,
      session.preview,
      session.turnCount,
      session.remoteCreatedAt,
      session.remoteUpdatedAt,
      session.remoteSizeBytes,
      session.headerFingerprint,
      timestamp
    );
  }
}

/**
 * Reconciles rows the latest listing no longer reported. A row with a downloaded
 * transcript is kept and flagged, because that copy is still readable after the
 * remote file is gone. A row that was never opened has no content of its own, so
 * it is deleted rather than left claiming a local copy that does not exist.
 */
export function markMissingRemoteSessions(db: SqlDatabase, profileId: string, presentSessionIds: string[], timestamp: string): void {
  const present = new Set(presentSessionIds);
  const rows = db
    .prepare("SELECT session_id, missing_since, cached_bytes, transcript_path FROM remote_sessions WHERE profile_id = ?")
    .all(profileId) as Array<{ session_id: string; missing_since: string | null; cached_bytes: number; transcript_path: string | null }>;
  const flag = db.prepare("UPDATE remote_sessions SET missing_since = ? WHERE profile_id = ? AND session_id = ?");
  const drop = db.prepare("DELETE FROM remote_sessions WHERE profile_id = ? AND session_id = ?");
  for (const row of rows) {
    if (present.has(row.session_id)) continue;
    if (Number(row.cached_bytes ?? 0) <= 0 || !row.transcript_path) {
      drop.run(profileId, row.session_id);
      continue;
    }
    if (row.missing_since) continue;
    flag.run(timestamp, profileId, row.session_id);
  }
}

export function updateRemoteSessionCache(db: SqlDatabase, update: RemoteSessionCacheUpdate): void {
  db.prepare(`
    UPDATE remote_sessions
    SET cached_bytes = ?, cached_fingerprint = ?, transcript_path = ?, synced_at = ?,
        remote_size_bytes = COALESCE(?, remote_size_bytes)
    WHERE profile_id = ? AND session_id = ?
  `).run(
    update.cachedBytes,
    update.cachedFingerprint,
    update.transcriptPath,
    update.syncedAt,
    update.remoteSizeBytes,
    update.profileId,
    update.sessionId
  );
}

/**
 * Drops discovered workspaces the host no longer has any session for. They only
 * ever existed because a session pointed at that directory, so once the last one
 * is gone the row is an empty entry nothing can fill. Workspaces the user added
 * by hand are kept: those are a stated intention, not an inference.
 */
export function pruneDiscoveredRemoteWorkspaces(db: SqlDatabase, profileId: string, keepCwds: string[]): void {
  const rows = db
    .prepare("SELECT id, cwd FROM remote_workspaces WHERE profile_id = ? AND source = 'discovered'")
    .all(profileId) as Array<{ id: string; cwd: string }>;
  const keep = new Set(keepCwds);
  const drop = db.prepare("DELETE FROM remote_workspaces WHERE id = ?");
  for (const row of rows) {
    if (keep.has(row.cwd)) continue;
    drop.run(row.id);
  }
}

export function listRemoteSessionCwds(db: SqlDatabase, profileId: string): string[] {
  const rows = db
    .prepare("SELECT DISTINCT cwd FROM remote_sessions WHERE profile_id = ? AND cwd <> '' ORDER BY cwd")
    .all(profileId) as Array<{ cwd: string }>;
  return rows.map((row) => row.cwd);
}

/** Returns the cached transcript paths so the caller can delete the files it owns. */
export function removeRemoteProfileData(db: SqlDatabase, profileId: string): string[] {
  const rows = db
    .prepare("SELECT transcript_path FROM remote_sessions WHERE profile_id = ? AND transcript_path IS NOT NULL")
    .all(profileId) as Array<{ transcript_path: string }>;
  db.prepare("DELETE FROM remote_sessions WHERE profile_id = ?").run(profileId);
  db.prepare("DELETE FROM remote_workspaces WHERE profile_id = ?").run(profileId);
  return rows.map((row) => row.transcript_path);
}

export function defaultWorkspaceName(cwd: string): string {
  const segments = cwd.split("/").filter(Boolean);
  return segments[segments.length - 1] || cwd;
}

function mapWorkspace(row: WorkspaceRow): RemoteWorkspace {
  return {
    id: row.id,
    profileId: row.profile_id,
    cwd: row.cwd,
    name: row.name,
    pinned: row.pinned === 1,
    source: row.source,
    // The owning profile is not in SQLite, so the service fills this in.
    isDefaultCwd: false,
    sessionCount: Number(row.session_count ?? 0),
    latestSessionAt: row.latest_session_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSession(row: SessionRow): RemoteSessionRecord {
  const cachedBytes = Number(row.cached_bytes ?? 0);
  return {
    profileId: row.profile_id,
    sessionId: row.session_id,
    cwd: row.cwd,
    title: sessionTitle(row),
    name: row.name,
    preview: row.preview,
    turnCount: row.turn_count,
    remoteCreatedAt: row.remote_created_at,
    remoteUpdatedAt: row.remote_updated_at,
    remoteSizeBytes: row.remote_size_bytes,
    cachedBytes,
    state: sessionState(row, cachedBytes),
    listedAt: row.listed_at,
    headerFingerprint: row.header_fingerprint,
    cachedFingerprint: row.cached_fingerprint,
    transcriptPath: row.transcript_path,
    syncedAt: row.synced_at
  };
}

function sessionTitle(row: SessionRow): string {
  const name = row.name?.trim();
  if (name) return name;
  const preview = row.preview?.trim();
  if (preview) return preview;
  return row.session_id.slice(0, 8);
}

function sessionState(row: SessionRow, cachedBytes: number): RemoteSessionCacheState {
  if (row.missing_since) return "gone";
  if (cachedBytes <= 0 || !row.transcript_path) return "remote";
  // A rewritten prefix invalidates the cached copy no matter how the sizes
  // compare, so the fingerprint is checked before the byte counts.
  if (row.header_fingerprint && row.cached_fingerprint && row.header_fingerprint !== row.cached_fingerprint) return "stale";
  if (row.remote_size_bytes !== null && row.remote_size_bytes > cachedBytes) return "stale";
  return "cached";
}
