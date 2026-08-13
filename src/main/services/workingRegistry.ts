import type {
  WorkingNavigationTarget,
  WorkingNotificationMode,
  WorkingSnapshot,
  WorkingTask,
  WorkingTaskStatus
} from "../../shared/ipc.js";
import { translate, type Translate } from "../../shared/i18n.js";
import { WORKING_ACTIVITY, type WorkingActivity } from "../../shared/workingActivity.js";
import type { JasmineDatabase } from "../db/database.js";

export type WorkingNotification = {
  title: string;
  body: string;
  target: WorkingNavigationTarget;
};

export type WorkingRegistryHost = {
  broadcast(snapshot: WorkingSnapshot): void;
  isBackground(): boolean;
  showNotification(notification: WorkingNotification, onClick: () => void): boolean;
  route(target: WorkingNavigationTarget): void;
};

export class WorkingRegistry {
  private viewedThreadId: string | null = null;
  private stopHandler: ((requestId: string) => boolean) | null = null;
  private readonly lastActivities = new Map<string, string>();

  constructor(
    private readonly db: JasmineDatabase,
    private readonly host: WorkingRegistryHost
  ) {}

  initialize(): WorkingSnapshot {
    this.db.recoverInterruptedWorking();
    return this.publish();
  }

  snapshot(): WorkingSnapshot {
    return this.db.getWorkingSnapshot();
  }

  setStopHandler(handler: (requestId: string) => boolean): void {
    this.stopHandler = handler;
  }

  start(input: { requestId: string; threadId: string; activity?: WorkingActivity }): void {
    this.db.startWorkingTask({
      requestId: input.requestId,
      threadId: input.threadId,
      activity: input.activity ?? WORKING_ACTIVITY.preparing
    });
    this.lastActivities.set(input.requestId, input.activity ?? WORKING_ACTIVITY.preparing);
    this.publish();
  }

  activity(requestId: string, activity: WorkingActivity): void {
    if (this.lastActivities.get(requestId) === activity) return;
    this.lastActivities.set(requestId, activity);
    if (this.db.updateWorkingTask({ requestId, status: "running", activity })) this.publish();
  }

  queue(requestId: string, queueCount: number): void {
    if (this.db.updateWorkingTask({ requestId, queueCount })) this.publish();
  }

  waitingForUser(requestId: string): void {
    this.lastActivities.set(requestId, WORKING_ACTIVITY.waiting);
    if (!this.db.updateWorkingTask({
      requestId,
      status: "waiting_user",
      activity: WORKING_ACTIVITY.waiting,
      unread: true
    })) return;
    this.publish();
    this.maybeNotify(requestId, "waiting_user");
  }

  resumed(requestId: string): void {
    this.lastActivities.set(requestId, WORKING_ACTIVITY.resuming);
    if (this.db.updateWorkingTask({ requestId, status: "running", activity: WORKING_ACTIVITY.resuming })) this.publish();
  }

  stopping(requestId: string): void {
    if (this.db.updateWorkingTask({ requestId, status: "stopping", activity: WORKING_ACTIVITY.stopping })) this.publish();
  }

  finish(requestId: string, status: Extract<WorkingTaskStatus, "completed" | "failed" | "cancelled">): void {
    this.lastActivities.delete(requestId);
    const current = this.snapshot().items.find((item) => item.requestId === requestId);
    const viewedInForeground = current?.threadId === this.viewedThreadId && !this.host.isBackground();
    const finishedAt = new Date().toISOString();
    if (!this.db.updateWorkingTask({
      requestId,
      status,
      activity: terminalActivity(status),
      finishedAt,
      queueCount: 0,
      unread: status !== "cancelled" && !viewedInForeground
    })) return;
    this.publish();
    if (status === "completed" || status === "failed") this.maybeNotify(requestId, status);
  }

  stop(requestId: string): boolean {
    const stopped = this.stopHandler?.(requestId) ?? false;
    if (stopped) this.stopping(requestId);
    return stopped;
  }

  markRead(requestId: string): WorkingSnapshot {
    this.db.markWorkingRead(requestId);
    return this.publish();
  }

  clearCompleted(): WorkingSnapshot {
    this.db.clearCompletedWorking();
    return this.publish();
  }

  viewThread(threadId: string | null): void {
    this.viewedThreadId = threadId;
    if (threadId && this.db.markWorkingThreadRead(threadId)) this.publish();
  }

  private maybeNotify(requestId: string, status: Extract<WorkingTaskStatus, "waiting_user" | "completed" | "failed">): void {
    const settings = this.db.getAppSettings().workingNotifications;
    if (settings.mode === "never") return;
    const task = this.snapshot().items.find((item) => item.requestId === requestId);
    if (!task) return;
    const isBackground = this.host.isBackground();
    if (task.threadId === this.viewedThreadId && !isBackground) return;
    if (!shouldNotifyForMode(settings.mode, isBackground)) return;
    // Claim the request/status before constructing the OS notification. Main
    // process transitions are serialized, so this is the durable dedupe gate
    // even if two completion callbacks arrive back-to-back.
    if (!this.db.markWorkingNotificationSent(requestId, status)) return;
    const target = toNavigationTarget(task);
    // Main writes this text while the window is hidden, so it translates with
    // the same dictionary the renderer uses rather than shipping English.
    const notification = notificationCopy(task, status, settings.includeDetails, target, translate(this.db.getAppSettings().language));
    try {
      this.host.showNotification(notification, () => {
        this.db.markWorkingRead(requestId);
        this.publish();
        this.host.route(target);
      });
    } catch {
      // Windows notifications are best-effort. The persisted unread Working
      // item remains the reliable fallback and the completed run stays intact.
    }
  }

  private publish(): WorkingSnapshot {
    const snapshot = this.snapshot();
    this.host.broadcast(snapshot);
    return snapshot;
  }
}

export function shouldNotifyForMode(mode: WorkingNotificationMode, isBackground: boolean): boolean {
  return mode === "always" || (mode === "background" && isBackground);
}

function notificationCopy(
  task: WorkingTask,
  status: Extract<WorkingTaskStatus, "waiting_user" | "completed" | "failed">,
  includeDetails: boolean,
  target: WorkingNavigationTarget,
  t: Translate
): WorkingNotification {
  const state = status === "completed"
    ? t("working.notification.completed")
    : status === "failed"
      ? t("working.notification.failed")
      : t("working.notification.waiting");
  return {
    title: t("working.notification.title", { state }),
    body: includeDetails
      ? t("working.notification.detail", { project: task.projectName ?? t("working.noProject"), title: task.threadTitle })
      : status === "waiting_user"
        ? t("working.notification.bodyWaiting")
        : status === "completed"
          ? t("working.notification.bodyCompleted")
          : t("working.notification.bodyFailed"),
    target
  };
}

function toNavigationTarget(task: WorkingTask): WorkingNavigationTarget {
  return {
    requestId: task.requestId,
    threadId: task.threadId,
    projectId: task.projectId
  };
}

function terminalActivity(status: "completed" | "failed" | "cancelled"): string {
  if (status === "completed") return WORKING_ACTIVITY.completed;
  if (status === "failed") return WORKING_ACTIVITY.failed;
  return WORKING_ACTIVITY.cancelled;
}
