import { useEffect, useMemo, useState } from "react";
import type { WorkingSnapshot, WorkingTask, WorkingTaskStatus } from "../../../shared/ipc";
import { StopIcon, TrashIcon, WorkingIcon } from "../icons/Icons";
import { Button, EmptyState } from "../ui";
import { useI18n } from "../../i18n";

const ACTIVE_STATUSES: WorkingTaskStatus[] = ["running", "waiting_user", "stopping"];

export function WorkingPage(props: {
  snapshot: WorkingSnapshot;
  loading: boolean;
  onOpen(task: WorkingTask): void;
  onStop(requestId: string): void;
  onClearCompleted(): void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  const groups = useMemo(() => ({
    attention: props.snapshot.items.filter((task) => task.status === "waiting_user" || task.status === "failed"),
    progress: props.snapshot.items.filter((task) => task.status === "running" || task.status === "stopping"),
    recent: props.snapshot.items.filter((task) => task.status === "completed" || task.status === "cancelled" || task.status === "interrupted")
  }), [props.snapshot.items]);

  useEffect(() => {
    if (props.snapshot.activeCount === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [props.snapshot.activeCount]);

  const empty = props.snapshot.items.length === 0;
  const clearableCount = props.snapshot.items.filter((task) => ["completed", "failed", "cancelled", "interrupted"].includes(task.status)).length;
  return (
    <section className="working-page" aria-label={t("working.title")}>
      <header className="working-header">
        <div className="working-title-group">
          <span className="working-title-icon"><WorkingIcon /></span>
          <div>
            <h1>{t("working.title")}</h1>
            <p>{t("working.subtitle")}</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="quiet"
          leftIcon={<TrashIcon />}
          disabled={clearableCount === 0}
          onClick={props.onClearCompleted}
        >
          {t("working.clearCompleted")}
        </Button>
      </header>

      <div className="working-content">
        {props.loading && empty ? (
          <div className="working-loading" role="status"><div /><div /><div /></div>
        ) : empty ? (
          <EmptyState title={t("working.empty.title")} subtitle={t("working.empty.description")} />
        ) : (
          <div className="working-groups">
            <WorkingGroup title={t("working.group.attention")} tone="attention" tasks={groups.attention} now={now} onOpen={props.onOpen} onStop={props.onStop} />
            <WorkingGroup title={t("working.group.progress")} tasks={groups.progress} now={now} onOpen={props.onOpen} onStop={props.onStop} />
            <WorkingGroup title={t("working.group.recent")} tasks={groups.recent} now={now} onOpen={props.onOpen} onStop={props.onStop} />
          </div>
        )}
      </div>
    </section>
  );
}

function WorkingGroup(props: {
  title: string;
  tone?: "attention";
  tasks: WorkingTask[];
  now: number;
  onOpen(task: WorkingTask): void;
  onStop(requestId: string): void;
}) {
  const { t } = useI18n();
  return (
    <section className={`working-group ${props.tone ?? ""}`}>
      <div className="working-group-heading">
        <h2>{props.title}</h2>
        <span>{props.tasks.length}</span>
      </div>
      {props.tasks.length === 0 ? <p className="working-group-empty">{t("working.group.empty")}</p> : (
        <div className="working-task-list">
          {props.tasks.map((task) => (
            <article className={`working-task status-${task.status} ${task.unread ? "unread" : ""}`} data-request-id={task.requestId} key={task.requestId}>
              <Button className="working-task-main" variant="ghost" onClick={() => props.onOpen(task)}>
                <span className="working-task-status-dot" aria-hidden="true" />
                <span className="working-task-copy">
                  <span className="working-task-title">{task.threadTitle}</span>
                  <span className="working-task-meta">{task.projectName ?? t("working.noProject")}</span>
                  <span className="working-task-activity">{statusLabel(task.status, t)} · {task.activity}</span>
                </span>
                <span className="working-task-aside">
                  <time>{formatTaskTime(task, props.now)}</time>
                  {task.queueCount > 0 ? <span>{t("working.queued", { count: task.queueCount })}</span> : null}
                  {task.unread ? <span className="working-unread">{t("working.unread")}</span> : null}
                </span>
              </Button>
              {ACTIVE_STATUSES.includes(task.status) ? (
                <Button
                  className="working-stop"
                  size="sm"
                  variant="quiet"
                  leftIcon={<StopIcon />}
                  disabled={task.status === "stopping"}
                  onClick={() => props.onStop(task.requestId)}
                >
                  {task.status === "stopping" ? t("working.stopping") : t("working.stop")}
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function statusLabel(status: WorkingTaskStatus, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "running") return t("working.status.running");
  if (status === "waiting_user") return t("working.status.waiting_user");
  if (status === "stopping") return t("working.status.stopping");
  if (status === "completed") return t("working.status.completed");
  if (status === "failed") return t("working.status.failed");
  if (status === "cancelled") return t("working.status.cancelled");
  return t("working.status.interrupted");
}

function formatTaskTime(task: WorkingTask, now: number): string {
  if (task.finishedAt) return new Date(task.finishedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const elapsed = Math.max(0, now - new Date(task.startedAt).getTime());
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
