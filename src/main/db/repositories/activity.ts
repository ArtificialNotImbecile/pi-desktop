import { randomUUID } from "node:crypto";
import type { ActivityObservation, ActivitySettings } from "../../../shared/ipc.js";
import type { SqlDatabase } from "./types.js";

type ActivitySettingsRow = {
  id: string;
  enabled: number;
  paused: number;
  local_only: number;
  capture_window_titles: number;
  capture_screenshots: number;
  retention_days: number;
  updated_at: string;
};

type ActivityObservationRow = {
  id: string;
  note: string;
  source: "manual";
  created_at: string;
};

export function getActivitySettings(db: SqlDatabase): ActivitySettings | null {
  const row = db
    .prepare(
      "SELECT id, enabled, paused, local_only, capture_window_titles, capture_screenshots, retention_days, updated_at FROM activity_settings WHERE id = 'default'"
    )
    .get() as ActivitySettingsRow | undefined;
  return row ? mapActivitySettings(row) : null;
}

export function updateActivitySettings(
  db: SqlDatabase,
  settings: Omit<ActivitySettings, "updatedAt">,
  timestamp: string
): void {
  db.prepare(
    "UPDATE activity_settings SET enabled = ?, paused = ?, local_only = ?, capture_window_titles = ?, capture_screenshots = ?, retention_days = ?, updated_at = ? WHERE id = 'default'"
  ).run(
    settings.enabled ? 1 : 0,
    settings.paused ? 1 : 0,
    settings.localOnly ? 1 : 0,
    settings.captureWindowTitles ? 1 : 0,
    settings.captureScreenshots ? 1 : 0,
    settings.retentionDays,
    timestamp
  );
}

export function listActivityObservations(db: SqlDatabase, input: { query?: string } = {}): ActivityObservation[] {
  const query = input.query?.trim();
  if (query) {
    return db
      .prepare("SELECT id, note, source, created_at FROM activity_observations WHERE note LIKE ? ORDER BY created_at DESC")
      .all(`%${query}%`)
      .map((row) => mapActivityObservation(row as ActivityObservationRow));
  }
  return db
    .prepare("SELECT id, note, source, created_at FROM activity_observations ORDER BY created_at DESC")
    .all()
    .map((row) => mapActivityObservation(row as ActivityObservationRow));
}

export function createManualActivityObservation(db: SqlDatabase, input: { note: string }, timestamp: string): ActivityObservation {
  const note = input.note.trim();
  if (!note) throw new Error("Activity note is empty.");
  const observation: ActivityObservation = {
    id: randomUUID(),
    note,
    source: "manual",
    createdAt: timestamp
  };

  db.prepare("INSERT INTO activity_observations (id, note, source, created_at) VALUES (?, ?, ?, ?)")
    .run(observation.id, observation.note, observation.source, observation.createdAt);

  return observation;
}

function mapActivitySettings(row: ActivitySettingsRow): ActivitySettings {
  return {
    enabled: row.enabled === 1,
    paused: row.paused === 1,
    localOnly: row.local_only === 1,
    captureWindowTitles: row.capture_window_titles === 1,
    captureScreenshots: row.capture_screenshots === 1,
    retentionDays: Number(row.retention_days ?? 30),
    updatedAt: row.updated_at
  };
}

function mapActivityObservation(row: ActivityObservationRow): ActivityObservation {
  return {
    id: row.id,
    note: row.note,
    source: row.source,
    createdAt: row.created_at
  };
}
