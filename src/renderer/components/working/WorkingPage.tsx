import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { WorkingSnapshot, WorkingTask, WorkingTaskStatus } from "../../../shared/ipc";
import { WORKING_ACTIVITY, toolNameFromActivity } from "../../../shared/workingActivity";
import { StopIcon, TrashIcon, WorkingIcon } from "../icons/Icons";
import { Button, EmptyState } from "../ui";
import { useI18n, type I18nKey } from "../../i18n";

const ACTIVE_STATUSES: WorkingTaskStatus[] = ["running", "waiting_user", "stopping"];
const ATTENTION_STATUSES: WorkingTaskStatus[] = ["waiting_user", "failed"];
const DONE_STATUSES: WorkingTaskStatus[] = ["completed", "cancelled", "interrupted"];
const TERMINAL_STATUSES: WorkingTaskStatus[] = ["completed", "failed", "cancelled", "interrupted"];
// Main persists activity in English whatever the UI language is. Every line
// Jasmine writes for itself is listed in shared/workingActivity and translated
// here; tests/unit/working-activity-i18n.mjs fails if the two lists drift.
// Text from a model or a tool is not in this table and is shown as written.
const ACTIVITY_KEYS: Record<string, I18nKey> = {
  [WORKING_ACTIVITY.preparing]: "working.activity.preparing",
  [WORKING_ACTIVITY.preparingRetry]: "working.activity.preparingRetry",
  [WORKING_ACTIVITY.preparingEdit]: "working.activity.preparingEdit",
  [WORKING_ACTIVITY.resuming]: "working.activity.resuming",
  [WORKING_ACTIVITY.generating]: "working.activity.generating",
  [WORKING_ACTIVITY.thinking]: "working.activity.thinking",
  [WORKING_ACTIVITY.usingTool]: "working.activity.usingTool",
  [WORKING_ACTIVITY.processingToolResult]: "working.activity.processingToolResult",
  [WORKING_ACTIVITY.toolError]: "working.activity.toolError",
  [WORKING_ACTIVITY.writing]: "working.activity.writing",
  [WORKING_ACTIVITY.waiting]: "working.activity.waiting",
  [WORKING_ACTIVITY.stopping]: "working.activity.stopping",
  [WORKING_ACTIVITY.interrupted]: "working.activity.interrupted"
};
// These say nothing the status glyph and label have not already said, so a
// finished row spends the line on its duration instead.
const GENERIC_TERMINAL_ACTIVITY = new Set<string>([
  WORKING_ACTIVITY.completed,
  WORKING_ACTIVITY.failed,
  WORKING_ACTIVITY.cancelled
]);
// Finished runs are history: they stay one click away instead of pushing the
// tasks that still need a decision off the first screen.
const DONE_PREVIEW_COUNT = 5;

type WorkingFilter = "all" | "attention" | "running" | "done";

export function WorkingPage(props: {
  snapshot: WorkingSnapshot;
  loading: boolean;
  onOpen(task: WorkingTask): void;
  onStop(requestId: string): void;
  onClearCompleted(): void;
  onNewChat(): void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  const [filter, setFilter] = useState<WorkingFilter>("all");
  const [showAllDone, setShowAllDone] = useState(false);
  const groups = useMemo(() => ({
    attention: props.snapshot.items.filter((task) => ATTENTION_STATUSES.includes(task.status)),
    progress: props.snapshot.items.filter((task) => task.status === "running" || task.status === "stopping"),
    done: props.snapshot.items.filter((task) => DONE_STATUSES.includes(task.status))
  }), [props.snapshot.items]);

  useEffect(() => {
    if (props.snapshot.activeCount === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [props.snapshot.activeCount]);

  const empty = props.snapshot.items.length === 0;
  const clearableCount = props.snapshot.items.filter((task) => TERMINAL_STATUSES.includes(task.status)).length;
  const waitingCount = groups.attention.filter((task) => task.status === "waiting_user").length;
  const failedCount = groups.attention.length - waitingCount;
  // A waiting task keeps its queue, but the Running filter cannot show it, so
  // counting it here would advertise work that pressing the tile hides.
  const queuedCount = groups.progress.reduce((total, task) => total + task.queueCount, 0);
  const lastFinishedAt = groups.done.reduce<string | null>((latest, task) => (
    task.finishedAt && (!latest || task.finishedAt > latest) ? task.finishedAt : latest
  ), null);
  const visible = {
    attention: filter === "all" || filter === "attention" ? groups.attention : [],
    progress: filter === "all" || filter === "running" ? groups.progress : [],
    done: filter === "all" || filter === "done" ? groups.done : []
  };
  const nothingVisible = visible.attention.length === 0 && visible.progress.length === 0 && visible.done.length === 0;

  return (
    <section className="working-page" aria-label={t("working.title")}>
      <header className="working-header">
        <div className="working-title-group">
          <h1>{t("working.title")}</h1>
          <p className={groups.attention.length > 0 ? "working-headline attention" : "working-headline"}>
            {headline(groups.progress.length, groups.attention.length, t)}
          </p>
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
          <EmptyState
            icon={<WorkingIcon />}
            title={t("working.empty.title")}
            subtitle={t("working.empty.description")}
            action={<Button size="sm" variant="primary" onClick={props.onNewChat}>{t("working.empty.action")}</Button>}
          />
        ) : (
          <div className="working-column">
            <div className="working-summary" role="group" aria-label={t("working.filter.label")}>
              <WorkingFilterTile
                filter="attention"
                tone="attention"
                active={filter === "attention"}
                label={t("working.filter.attention")}
                count={groups.attention.length}
                note={groups.attention.length === 0
                  ? t("working.filter.note.attentionIdle")
                  : t("working.filter.note.attention", { waiting: waitingCount, failed: failedCount })}
                onSelect={setFilter}
              />
              <WorkingFilterTile
                filter="running"
                active={filter === "running"}
                label={t("working.filter.running")}
                count={groups.progress.length}
                note={queuedCount === 0
                  ? t("working.filter.note.runningIdle")
                  : t("working.filter.note.running", { count: queuedCount })}
                onSelect={setFilter}
              />
              <WorkingFilterTile
                filter="done"
                active={filter === "done"}
                label={t("working.filter.done")}
                count={groups.done.length}
                note={lastFinishedAt
                  ? t("working.filter.note.done", { time: formatClock(lastFinishedAt) })
                  : t("working.filter.note.doneIdle")}
                onSelect={setFilter}
              />
            </div>

            {nothingVisible ? <p className="working-group-empty">{t("working.group.empty")}</p> : (
              <div className="working-groups">
                <WorkingGroup group="attention" title={t("working.group.attention")} tone="attention" tasks={visible.attention} now={now} onOpen={props.onOpen} onStop={props.onStop} />
                <WorkingGroup group="running" title={t("working.group.progress")} tasks={visible.progress} now={now} onOpen={props.onOpen} onStop={props.onStop} />
                <WorkingGroup
                  group="done"
                  title={t("working.group.recent")}
                  tasks={showAllDone ? visible.done : visible.done.slice(0, DONE_PREVIEW_COUNT)}
                  // Collapsing caps the rows on screen, not how many finished
                  // runs there are; the heading has to agree with the tile.
                  count={visible.done.length}
                  now={now}
                  onOpen={props.onOpen}
                  onStop={props.onStop}
                  action={visible.done.length > DONE_PREVIEW_COUNT ? (
                    <Button className="working-group-link" size="sm" variant="quiet" onClick={() => setShowAllDone((shown) => !shown)}>
                      {showAllDone ? t("working.showLess") : t("working.showAll", { count: visible.done.length })}
                    </Button>
                  ) : null}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function WorkingFilterTile(props: {
  filter: WorkingFilter;
  tone?: "attention";
  active: boolean;
  label: string;
  count: number;
  note: string;
  onSelect(filter: WorkingFilter): void;
}) {
  const highlight = props.tone === "attention" && props.count > 0;
  return (
    <button
      className={`working-tile ${props.active ? "active" : ""} ${highlight ? "attention" : ""}`}
      type="button"
      aria-pressed={props.active}
      // Pressing the active tile is the way back to the unfiltered list.
      onClick={() => props.onSelect(props.active ? "all" : props.filter)}
    >
      <span className="working-tile-label">{props.label}</span>
      <span className="working-tile-count">{props.count}</span>
      <span className="working-tile-note">{props.note}</span>
    </button>
  );
}

function WorkingGroup(props: {
  group: WorkingFilter;
  title: string;
  tone?: "attention";
  tasks: WorkingTask[];
  count?: number;
  now: number;
  action?: ReactNode;
  onOpen(task: WorkingTask): void;
  onStop(requestId: string): void;
}) {
  const { t } = useI18n();
  // An empty group is not news; it renders nothing rather than a placeholder.
  if (props.tasks.length === 0) return null;
  return (
    <section className={`working-group ${props.tone ?? ""}`} data-working-group={props.group}>
      <div className="working-group-heading">
        <h2>{props.title}</h2>
        <span>{props.count ?? props.tasks.length}</span>
        {props.action ? <div className="working-group-action">{props.action}</div> : null}
      </div>
      <div className="working-task-list">
        {props.tasks.map((task) => (
          <article className={`working-task status-${task.status} ${task.unread ? "unread" : ""}`} data-request-id={task.requestId} key={task.requestId}>
            <Button className="working-task-main" variant="ghost" onClick={() => props.onOpen(task)}>
              <span className="working-task-glyph" aria-hidden="true">
                <span className="working-task-status-dot" />
              </span>
              <span className="working-task-copy">
                <span className="working-task-title">{task.threadTitle}</span>
                <span className="working-task-detail">
                  {terminalLabel(task.status, t) ? <span className="working-task-status-label">{terminalLabel(task.status, t)}</span> : null}
                  {detailText(task, t) ? <span className="working-task-activity">{detailText(task, t)}</span> : null}
                  <span className="working-task-meta">{task.projectName ?? t("working.noProject")}</span>
                </span>
              </span>
              <span className="working-task-aside">
                {task.queueCount > 0 ? <span className="working-chip">{t("working.queued", { count: task.queueCount })}</span> : null}
                {task.unread ? <span className="working-unread">{t("working.unread")}</span> : null}
                <time dateTime={task.finishedAt ?? task.startedAt}>{formatTaskTime(task, props.now)}</time>
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
            {task.status === "running" ? <span className="working-task-progress" aria-hidden="true"><i /></span> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

// The old subtitle explained the page every time you opened it. This says what
// is true right now instead.
function headline(runningCount: number, attentionCount: number, t: ReturnType<typeof useI18n>["t"]): string {
  const parts: string[] = [];
  if (runningCount > 0) parts.push(t("working.headline.running", { count: runningCount }));
  if (attentionCount > 0) parts.push(t("working.headline.attention", { count: attentionCount }));
  return parts.length > 0 ? parts.join(" · ") : t("working.headline.idle");
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

// A green tick already says "completed"; only the outcomes a colour alone
// cannot spell out keep a written label.
function terminalLabel(status: WorkingTaskStatus, t: ReturnType<typeof useI18n>["t"]): string | null {
  if (status === "failed" || status === "cancelled" || status === "interrupted") return statusLabel(status, t);
  return null;
}

// The status is carried by the glyph and the label above, so this line spends
// itself on what the run is actually doing -- or, once it is over, how long it
// took. The registry writes activity in English whatever the UI language is, so
// its stock lines are translated here and only real work (a path, a tool name)
// is passed through as written.
function detailText(task: WorkingTask, t: ReturnType<typeof useI18n>["t"]): string {
  const activity = task.activity.trim();
  const ownKey = ACTIVITY_KEYS[activity];
  if (ownKey) return t(ownKey);
  const toolName = toolNameFromActivity(activity);
  if (toolName) return t("working.activity.usingNamedTool", { tool: toolName });
  if (!TERMINAL_STATUSES.includes(task.status)) return activity;
  if (activity && !GENERIC_TERMINAL_ACTIVITY.has(activity)) return activity;
  const duration = taskDuration(task);
  return duration ? t("working.took", { duration }) : "";
}

function taskDuration(task: WorkingTask): string | null {
  if (!task.finishedAt) return null;
  const elapsed = new Date(task.finishedAt).getTime() - new Date(task.startedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return formatElapsed(elapsed);
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatTaskTime(task: WorkingTask, now: number): string {
  if (task.finishedAt) return formatClock(task.finishedAt);
  return formatElapsed(Math.max(0, now - new Date(task.startedAt).getTime()));
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
