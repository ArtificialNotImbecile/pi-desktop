import type { WorkingSnapshot, WorkingTask, WorkingTaskStatus } from "../../../shared/ipc.js";
import { WORKING_ACTIVITY } from "../../../shared/workingActivity.js";
import type { SqlDatabase } from "./types.js";

const ACTIVE_STATUSES: WorkingTaskStatus[] = ["running", "waiting_user", "stopping"];
const TERMINAL_STATUSES: WorkingTaskStatus[] = ["completed", "failed", "cancelled", "interrupted"];

type WorkingTaskRow = {
  request_id: string;
  thread_id: string;
  thread_title: string;
  project_id: string | null;
  project_name: string | null;
  status: WorkingTaskStatus;
  activity: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  queue_count: number;
  unread: number;
};

export function listWorkingTasks(db: SqlDatabase, recentSince: string): WorkingSnapshot {
  const rows = db.prepare(`
    SELECT tasks.request_id, tasks.thread_id, threads.title AS thread_title,
           threads.project_id, projects.name AS project_name, tasks.status,
           tasks.activity, tasks.started_at, tasks.updated_at, tasks.finished_at,
           tasks.queue_count, tasks.unread
    FROM working_tasks AS tasks
    JOIN chat_threads AS threads ON threads.id = tasks.thread_id
    LEFT JOIN workspace_projects AS projects ON projects.id = threads.project_id
    WHERE tasks.status IN ('running', 'waiting_user', 'stopping')
       OR tasks.unread = 1
       OR tasks.finished_at >= ?
    ORDER BY
      CASE tasks.status
        WHEN 'waiting_user' THEN 0
        WHEN 'failed' THEN 1
        WHEN 'running' THEN 2
        WHEN 'stopping' THEN 3
        ELSE 4
      END,
      COALESCE(tasks.finished_at, tasks.updated_at) DESC
  `).all(recentSince) as WorkingTaskRow[];
  const items = rows.map(mapWorkingTask);
  return {
    items,
    activeCount: items.filter((item) => ACTIVE_STATUSES.includes(item.status)).length,
    attentionCount: items.filter((item) => item.status === "waiting_user" || item.status === "failed").length
  };
}

export function startWorkingTask(
  db: SqlDatabase,
  input: { requestId: string; threadId: string; activity: string },
  timestamp: string
): void {
  db.prepare(`
    INSERT INTO working_tasks (
      thread_id, request_id, status, activity, started_at, updated_at,
      finished_at, queue_count, unread, notified_statuses_json
    ) VALUES (?, ?, 'running', ?, ?, ?, NULL, 0, 0, '[]')
    ON CONFLICT(thread_id) DO UPDATE SET
      request_id = excluded.request_id,
      status = 'running',
      activity = excluded.activity,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at,
      finished_at = NULL,
      queue_count = 0,
      unread = 0,
      notified_statuses_json = '[]'
  `).run(input.threadId, input.requestId, safeActivity(input.activity), timestamp, timestamp);
}

export function updateWorkingTask(
  db: SqlDatabase,
  input: {
    requestId: string;
    status?: WorkingTaskStatus;
    activity?: string;
    queueCount?: number;
    unread?: boolean;
    finishedAt?: string | null;
  },
  timestamp: string
): boolean {
  const current = db.prepare(`
    SELECT status, activity, queue_count, unread, finished_at
    FROM working_tasks WHERE request_id = ?
  `).get(input.requestId) as {
    status: WorkingTaskStatus;
    activity: string;
    queue_count: number;
    unread: number;
    finished_at: string | null;
  } | undefined;
  if (!current) return false;
  const result = db.prepare(`
    UPDATE working_tasks SET status = ?, activity = ?, queue_count = ?, unread = ?,
      finished_at = ?, updated_at = ?
    WHERE request_id = ?
  `).run(
    input.status ?? current.status,
    input.activity === undefined ? current.activity : safeActivity(input.activity),
    input.queueCount === undefined ? current.queue_count : Math.max(0, Math.trunc(input.queueCount)),
    input.unread === undefined ? current.unread : input.unread ? 1 : 0,
    input.finishedAt === undefined ? current.finished_at : input.finishedAt,
    timestamp,
    input.requestId
  );
  return result.changes === 1;
}

export function markWorkingRead(db: SqlDatabase, requestId: string, timestamp: string): boolean {
  const result = db.prepare(`
    UPDATE working_tasks SET unread = 0, updated_at = ? WHERE request_id = ?
  `).run(timestamp, requestId);
  return result.changes === 1;
}

export function markWorkingThreadRead(db: SqlDatabase, threadId: string, timestamp: string): boolean {
  const result = db.prepare(`
    UPDATE working_tasks SET unread = 0, updated_at = ? WHERE thread_id = ? AND unread = 1
  `).run(timestamp, threadId);
  return result.changes > 0;
}

export function clearCompletedWorking(db: SqlDatabase): number {
  return db.prepare(`
    DELETE FROM working_tasks WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
  `).run().changes;
}

export function recoverInterruptedWorking(db: SqlDatabase, timestamp: string): number {
  return db.prepare(`
    UPDATE working_tasks
    SET status = 'interrupted', activity = ?,
        updated_at = ?, finished_at = ?, queue_count = 0, unread = 1
    WHERE status IN ('running', 'waiting_user', 'stopping')
  `).run(WORKING_ACTIVITY.interrupted, timestamp, timestamp).changes;
}

export function deleteExpiredWorking(db: SqlDatabase, recentSince: string): number {
  return db.prepare(`
    DELETE FROM working_tasks
    WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
      AND unread = 0 AND finished_at < ?
  `).run(recentSince).changes;
}

export function markWorkingNotificationSent(
  db: SqlDatabase,
  requestId: string,
  status: WorkingTaskStatus
): boolean {
  const row = db.prepare(`
    SELECT notified_statuses_json FROM working_tasks WHERE request_id = ?
  `).get(requestId) as { notified_statuses_json: string } | undefined;
  if (!row) return false;
  const notified = parseStatuses(row.notified_statuses_json);
  if (notified.includes(status)) return false;
  notified.push(status);
  return db.prepare(`
    UPDATE working_tasks SET notified_statuses_json = ? WHERE request_id = ?
  `).run(JSON.stringify(notified), requestId).changes === 1;
}

export function isTerminalWorkingStatus(status: WorkingTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function mapWorkingTask(row: WorkingTaskRow): WorkingTask {
  return {
    requestId: row.request_id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    projectId: row.project_id,
    projectName: row.project_name,
    status: row.status,
    activity: row.activity,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    queueCount: Math.max(0, row.queue_count),
    unread: Boolean(row.unread)
  };
}

function parseStatuses(value: string): WorkingTaskStatus[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isWorkingStatus) : [];
  } catch {
    return [];
  }
}

function isWorkingStatus(value: unknown): value is WorkingTaskStatus {
  return typeof value === "string" && [...ACTIVE_STATUSES, ...TERMINAL_STATUSES].includes(value as WorkingTaskStatus);
}

function safeActivity(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return (normalized || "Working").slice(0, 160);
}
