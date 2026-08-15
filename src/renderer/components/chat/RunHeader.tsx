import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "../icons/Icons";
import { useI18n } from "../../i18n";
import { formatElapsedDuration, formatRunClock, type RunStatus } from "./runPresentation";

// One element carries a turn's run state from the first frame after send to the
// settled summary. While live it reads "Working 0:12"; once the run settles it
// becomes "Worked for 12s" and, on success, the control that folds the turn's
// activity away. It is never swapped for a different element mid-run, so the
// header does not move when the run ends.

type RunActivity = { runKey: string; stopping: boolean; model: string | null };

const RunActivityContext = createContext<RunActivity | null>(null);

export function RunActivityProvider(props: { value: RunActivity | null; children: ReactNode }) {
  return <RunActivityContext.Provider value={props.value}>{props.children}</RunActivityContext.Provider>;
}

export function useRunActivity(): RunActivity | null {
  return useContext(RunActivityContext);
}

// The clock origin is keyed by request, not by component, so the pre-stream
// placeholder header and the assistant block's own header report one continuous
// elapsed time across the handoff between them.
const runStartedAtCache = new Map<string, number>();
const RUN_START_CACHE_LIMIT = 500;

export function runStartedAt(runKey: string): number {
  const remembered = runStartedAtCache.get(runKey);
  if (remembered !== undefined) return remembered;
  if (runStartedAtCache.size >= RUN_START_CACHE_LIMIT) {
    const oldest = runStartedAtCache.keys().next().value;
    if (oldest !== undefined) runStartedAtCache.delete(oldest);
  }
  const startedAt = Date.now();
  runStartedAtCache.set(runKey, startedAt);
  return startedAt;
}

export function LiveRunHeader(props: { runKey: string; stopping: boolean; model: string | null }) {
  const { t } = useI18n();
  const [startedAt] = useState(() => runStartedAt(props.runKey));
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const label = props.stopping ? t("message.stopping") : t("message.working");
  const clock = formatRunClock(elapsedMs);
  // aria-label replaces the descendant text, and the meta span that carries the
  // model is aria-hidden so the clock is not read digit by digit. Name the model
  // here or it is absent from the accessibility tree for the whole run, which is
  // exactly when a reader needs to know which model is answering.
  const accessibleName = [label, props.model, clock].filter(Boolean).join(" ");
  // The model rides the same trailing slot the settled header uses, so the
  // header's shape does not change when the run ends. It names the model this
  // run is using, which a mid-run switch in the composer must not rewrite.
  return (
    <div
      className={`run-header live ${props.stopping ? "stopping" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={accessibleName}
    >
      <span className="run-header-title">{label}</span>
      <span className="run-header-meta" aria-hidden="true">
        {props.model && <small>{props.model}</small>}
        <time>{clock}</time>
      </span>
    </div>
  );
}

export function SettledRunHeader(props: {
  status: RunStatus;
  elapsedMs?: number;
  model: string | null;
  reasoningEffort: string | null;
  expandable: boolean;
  expanded: boolean;
  onToggle(): void;
}) {
  const { language, t } = useI18n();
  const duration = formatElapsedDuration(props.elapsedMs, language);
  const label = settledLabel(props.status, duration, t);
  const meta = [props.model, props.reasoningEffort].filter(Boolean).join(" · ");
  const accessibleName = [label, meta].filter(Boolean).join(", ");
  const content = (
    <>
      <span className="run-header-title">{label}</span>
      {props.expandable && <span className="run-header-chevron"><ChevronDownIcon /></span>}
      {meta && <small className="run-header-meta">{meta}</small>}
    </>
  );
  return (
    <div className={`run-header ${props.status} ${props.expanded ? "expanded" : "collapsed"}`}>
      {props.expandable ? (
        <button
          type="button"
          className="run-header-toggle"
          aria-label={accessibleName}
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          {content}
        </button>
      ) : (
        <div className="run-header-toggle" aria-label={accessibleName}>{content}</div>
      )}
      <span className="run-header-rule" aria-hidden="true" />
    </div>
  );
}

/**
 * A run that did no work and finished immediately reports only which model
 * answered. "Worked for 1s" under a one-line reply is noise, but which model
 * produced it is provenance a reader still needs after switching models.
 */
export function RunProvenanceLine(props: { model: string | null; reasoningEffort: string | null }) {
  const meta = [props.model, props.reasoningEffort].filter(Boolean).join(" · ");
  if (!meta) return null;
  return (
    <div className="run-header provenance-only" aria-label={meta}>
      <small className="run-header-meta">{meta}</small>
    </div>
  );
}

function settledLabel(status: RunStatus, duration: string | null, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "stopped") return duration ? t("message.stoppedAfter", { duration }) : t("message.stoppedRun");
  if (status === "error") return duration ? t("message.failedAfter", { duration }) : t("message.failedRun");
  return duration ? t("message.workedFor", { duration }) : t("message.completedRun");
}
