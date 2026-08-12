import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ChatMessage,
  FileChangeCaptureSummary,
  FileChangeDetail,
  FileChangeKind,
  FileChangeRevision,
  FileChangeStatus,
  FileChangeSummary,
  ThreadArtifactsResponse
} from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";
import { useThrottledValue } from "../../hooks/useThrottledValue";
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, InfoIcon } from "../icons/Icons";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

type CaptureAlert = { tone: "warning" | "danger"; label: string };
type DetailView = "diff" | "after" | "before";

export function ArtifactsPane(props: { threadId: string | null; messages: ChatMessage[] }) {
  const [data, setData] = useState<ThreadArtifactsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ threadId: string; changeId: string } | null>(null);
  const [detail, setDetail] = useState<{ threadId: string; changeId: string; change: FileChangeDetail } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [openCoverageId, setOpenCoverageId] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const messages = useThrottledValue(props.messages, 1000);
  const refreshKey = `${messages.length}:${messages.at(-1)?.id ?? ""}`;

  useEffect(() => {
    setData(null);
    setListError(null);
    setSelection(null);
    setDetail(null);
    setDetailError(null);
    setCollapsed(new Set());
    setOpenCoverageId(null);
    setInfoOpen(false);
  }, [props.threadId]);

  useEffect(() => {
    if (!props.threadId) {
      setData(null);
      setSelection(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setListError(null);
    getBridge().listThreadArtifacts(props.threadId)
      .then((response) => {
        if (!active || response.threadId !== props.threadId) return;
        setData(response);
        if (selection?.threadId === response.threadId && !response.captures.some((capture) => capture.changes.some((change) => change.id === selection.changeId))) {
          setSelection(null);
          setDetail(null);
        }
      })
      .catch((error) => {
        if (active) setListError(error instanceof Error ? error.message : "Unable to load file changes.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.threadId, refreshKey, selection]);

  useEffect(() => {
    if (!props.threadId || selection?.threadId !== props.threadId) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    let active = true;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    const requested = selection;
    getBridge().getThreadArtifactDetail(requested.threadId, requested.changeId)
      .then((response) => {
        if (active) setDetail({ ...requested, change: response.change });
      })
      .catch((error) => {
        if (active) setDetailError(error instanceof Error ? error.message : "Unable to load this file change.");
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.threadId, selection]);

  const captures = useMemo(
    () => [...(data?.threadId === props.threadId ? data.captures : [])].reverse(),
    [data, props.threadId]
  );
  const now = useTicking(captures.length > 0);
  const selectionMatchesThread = selection?.threadId === props.threadId;
  const visibleDetail = selectionMatchesThread
    && detail?.threadId === props.threadId
    && detail.changeId === selection.changeId
    ? detail.change
    : null;
  const selectedCapture = visibleDetail ? captures.find((capture) => capture.id === visibleDetail.captureId) ?? null : null;
  if (loading && captures.length === 0) return <p className="panel-empty">Loading file changes...</p>;
  if (listError && captures.length === 0) return <p className="artifact-detail-error" role="alert">Unable to load file changes: {listError}</p>;
  if (captures.length === 0) {
    return <p className="panel-empty">No file changes captured for this chat yet.</p>;
  }

  const totals = statusCounts(captures.flatMap((capture) => capture.changes.map((change) => change.status)));
  const changeCount = totals.added + totals.modified + totals.deleted;

  return (
    <div className="artifact-pane">
      {listError ? <p className="artifact-detail-error" role="alert">Unable to refresh file changes: {listError}</p> : null}
      <div className="artifact-pane-summary">
        <strong>{changeCount} {changeCount === 1 ? "change" : "changes"}</strong>
        <StatusTally counts={totals} />
        <span className="artifact-pane-turns">in {captures.length} {captures.length === 1 ? "turn" : "turns"}</span>
        <Button
          aria-expanded={infoOpen}
          aria-label="About file change capture"
          className="artifact-icon-button"
          leftIcon={<InfoIcon />}
          onClick={() => setInfoOpen((open) => !open)}
          size="sm"
          title="About file change capture"
          variant="quiet"
        />
      </div>
      {infoOpen ? <CaptureBasisNote captures={captures} /> : null}
      <div className="right-panel-list artifact-capture-list">
        {captures.map((capture) => (
          <CaptureGroup
            key={capture.id}
            capture={capture}
            coverageOpen={openCoverageId === capture.id}
            now={now}
            open={!collapsed.has(capture.id)}
            onOpen={(changeId) => props.threadId && setSelection({ threadId: props.threadId, changeId })}
            onToggle={() => setCollapsed((current) => toggleMember(current, capture.id))}
            onToggleCoverage={() => setOpenCoverageId((current) => (current === capture.id ? null : capture.id))}
          />
        ))}
      </div>
      <Dialog
        className="artifact-detail-dialog"
        closeLabel="Close"
        onClose={() => setSelection(null)}
        open={selectionMatchesThread}
        title={visibleDetail ? fileName(visibleDetail.relativePath || visibleDetail.path) : "File change"}
      >
        {detailLoading ? <p className="panel-empty">Loading file snapshot...</p> : null}
        {detailError ? <p className="artifact-detail-error" role="alert">{detailError}</p> : null}
        {visibleDetail ? <ArtifactDetailView change={visibleDetail} capture={selectedCapture} /> : null}
      </Dialog>
    </div>
  );
}

function CaptureGroup(props: {
  capture: FileChangeCaptureSummary;
  coverageOpen: boolean;
  now: number;
  open: boolean;
  onOpen(changeId: string): void;
  onToggle(): void;
  onToggleCoverage(): void;
}) {
  const capture = props.capture;
  const counts = statusCounts(capture.changes.map((change) => change.status));
  const alert = captureAlert(capture);
  const absoluteTime = formatTimestamp(capture.completedAt);
  return (
    <section className="artifact-capture" aria-label={`File changes captured ${absoluteTime}`}>
      <header className="artifact-capture-header">
        <Button
          aria-expanded={props.open}
          className="artifact-capture-toggle"
          onClick={props.onToggle}
          size="sm"
          title={absoluteTime}
          variant="quiet"
        >
          <span className="artifact-capture-chevron" aria-hidden="true">{props.open ? <ChevronDownIcon /> : <ChevronRightIcon />}</span>
          <span className="artifact-capture-when">{formatRelativeTime(capture.completedAt, props.now)}</span>
          <StatusTally counts={counts} />
        </Button>
        {alert ? (
          <Button
            aria-expanded={props.coverageOpen}
            className={`artifact-coverage-chip artifact-coverage-chip--${alert.tone}`}
            onClick={props.onToggleCoverage}
            size="sm"
            title="Show capture coverage"
            variant="quiet"
          >
            {alert.label}
          </Button>
        ) : null}
      </header>
      {alert && props.coverageOpen ? <CaptureCoverageNote capture={capture} /> : null}
      {props.open ? (
        <div className="artifact-change-list">
          {capture.changes.map((change) => (
            <Button
              className={`artifact-change-row artifact-change-row--${change.status}`}
              key={change.id}
              aria-label={`Open ${change.status} file ${change.relativePath || change.path}`}
              onClick={() => props.onOpen(change.id)}
              size="sm"
              title={change.relativePath || change.path}
              variant="quiet"
            >
              <StatusGlyph status={change.status} />
              <span className="artifact-change-name">{fileName(change.relativePath || change.path)}</span>
              {change.kind === "text" ? null : <span className="artifact-change-kind">{kindTag(change.kind)}</span>}
              <span className="artifact-change-dir">{directoryLabel(change.relativePath || change.path)}</span>
              <ChangeStat change={change} />
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Capture-specific trouble: why this run's evidence is incomplete. */
function CaptureCoverageNote(props: { capture: FileChangeCaptureSummary }) {
  const capture = props.capture;
  const coverage = capture.coverage;
  const issues = coverage.issues?.slice(0, 20) ?? [];
  const hiddenIssues = Math.max((coverage.issues?.length ?? 0) - issues.length, 0) + (coverage.omittedIssueCount ?? 0);
  return (
    <div className="artifact-note" role="status">
      {coverage.status === "complete" ? null : (
        <p>{coverage.reason || "Some configured paths could not be captured."}</p>
      )}
      {coverage.bashInvoked ? <p>{bashScopeNote(coverage.bashCoverage)}</p> : null}
      {capture.warnings.map((warning, index) => <p key={`warning:${index}`}>{warning}</p>)}
      {issues.map((issue, index) => (
        <p key={`${issue.code}:${issue.rootId}:${issue.path ?? ""}:${index}`}><code>{issue.code}</code> {issue.message}</p>
      ))}
      {hiddenIssues > 0 ? <p>{hiddenIssues} more coverage issues were omitted.</p> : null}
      {coverage.omittedWarningCount ? <p>{coverage.omittedWarningCount} more warnings were omitted.</p> : null}
    </div>
  );
}

/** Facts that hold for every capture in the thread, so they are stated once. */
function CaptureBasisNote(props: { captures: FileChangeCaptureSummary[] }) {
  const modes = new Set(props.captures.map((capture) => capture.coverage.trackingMode ?? "watcher"));
  const roots = uniqueStrings(props.captures.flatMap((capture) => (
    capture.coverage.rootDetails?.length
      ? capture.coverage.rootDetails.map((root) => root.physicalPath || root.path)
      : capture.roots
  )));
  const excludes = uniqueStrings(props.captures.flatMap((capture) => capture.excludes));
  return (
    <div className="artifact-note" role="status">
      {modes.has("watcher") ? <p>Watcher mode is event-based: no initial directory scan runs, so an update can have an after-only preview.</p> : null}
      {modes.has("managed-tools-only") ? <p>Managed mode records approved write and edit targets only. Shell changes are not tracked.</p> : null}
      <p>Captures are kept as run evidence. Editing the conversation does not roll files back.</p>
      {roots.length > 0 ? <p><strong>Watched</strong> <code>{roots.join(", ")}</code></p> : null}
      {excludes.length > 0 ? <p><strong>Excluded</strong> <code>{excludes.join(", ")}</code></p> : null}
    </div>
  );
}

function ArtifactDetailView(props: { change: FileChangeDetail; capture: FileChangeCaptureSummary | null }) {
  const change = props.change;
  const views = availableViews(change);
  const [view, setView] = useState<DetailView>(views[0] ?? "diff");
  const active = views.includes(view) ? view : views[0] ?? "diff";
  const directory = directoryLabel(change.relativePath || change.path);
  return (
    <div className="artifact-detail">
      <div className="artifact-detail-meta">
        <StatusGlyph status={change.status} />
        {directory ? <span className="artifact-detail-dir">{directory}</span> : null}
        {directory ? <span className="artifact-detail-separator" aria-hidden="true">·</span> : null}
        <RevisionFacts change={change} capture={props.capture} />
        {views.length > 1 ? (
          <div className="artifact-detail-views" role="group" aria-label="Preview mode">
            {views.map((candidate) => (
              <Button
                aria-pressed={candidate === active}
                className={candidate === active ? "active" : ""}
                key={candidate}
                onClick={() => setView(candidate)}
                size="sm"
                variant="quiet"
              >
                {candidate === "diff" ? "Diff" : candidate === "after" ? "After" : "Before"}
              </Button>
            ))}
          </div>
        ) : null}
        <Button
          aria-label="Copy full path"
          className="artifact-icon-button"
          leftIcon={<CopyIcon />}
          onClick={() => void copyPath(change.path)}
          size="sm"
          title={change.path}
          variant="quiet"
        />
      </div>
      {change.kind === "image" ? (
        <ImageChangePreview before={change.before} after={change.after} status={change.status} />
      ) : active === "diff" && change.unifiedDiff ? (
        <UnifiedDiff diff={change.unifiedDiff} truncated={change.diffTruncated} />
      ) : (
        <SnapshotFallback change={change} side={active === "before" ? "before" : "after"} />
      )}
    </div>
  );
}

/** One line replacing the old before/after property table. */
function RevisionFacts(props: { change: FileChangeDetail; capture: FileChangeCaptureSummary | null }) {
  const { before, after } = props.change;
  const facts: ReactNode[] = [];
  const size = pairLabel(before && formatBytes(before.size), after && formatBytes(after.size));
  const mode = pairLabel(before?.mode, after?.mode);
  const hash = pairLabel(shortHash(before?.sha256), shortHash(after?.sha256));
  if (size) facts.push(size);
  if (mode) facts.push(mode);
  if (hash) facts.push(hash);
  if (props.change.lineStats) facts.push(`+${props.change.lineStats.added} −${props.change.lineStats.deleted}`);
  if (props.capture) facts.push(trackingLabel(props.capture.coverage.trackingMode));
  if (facts.length === 0) return null;
  return (
    <span className="artifact-detail-facts">
      {facts.map((fact, index) => <span key={index}>{fact}</span>)}
    </span>
  );
}

function SnapshotFallback(props: { change: FileChangeDetail; side: "before" | "after" }) {
  const preferred = props.side === "before" ? props.change.before : props.change.after;
  const revision = preferred ?? (props.change.status === "deleted" ? props.change.before : props.change.after ?? props.change.before);
  if (revision?.redacted) {
    return <p className="artifact-preview-unavailable">Content and diff were redacted because the path may contain secrets.</p>;
  }
  if (revision?.encoding === "utf8" && revision.content !== undefined) {
    return (
      <div className="artifact-text-snapshot">
        <header>{revision === props.change.before ? "Before" : "After"}</header>
        <pre><code>{revision.content}</code></pre>
        {revision.contentTruncated ? <p>Preview truncated at the package capture limit.</p> : null}
      </div>
    );
  }
  if (revision?.contentTruncated) {
    return <p className="artifact-preview-unavailable">Preview content was omitted at the capture limit.</p>;
  }
  return <p className="artifact-preview-unavailable">No text or image preview is available for this file.</p>;
}

function ImageChangePreview(props: { before?: FileChangeRevision; after?: FileChangeRevision; status: FileChangeStatus }) {
  const revisions = [
    props.before ? { label: "Before", revision: props.before } : null,
    props.after ? { label: "After", revision: props.after } : null
  ].filter((value): value is { label: string; revision: FileChangeRevision } => value !== null);
  return (
    <div className={`artifact-image-comparison artifact-image-comparison--${props.status}`}>
      {revisions.map(({ label, revision }) => (
        <figure key={label}>
          <figcaption>{label}</figcaption>
          {imageDataUrl(revision) ? <img src={imageDataUrl(revision) ?? ""} alt={`${label} file snapshot`} /> : (
            <div className="artifact-preview-unavailable">
              {revision.redacted
                ? "Image preview was redacted."
                : revision.contentTruncated
                  ? "Image preview was omitted at the capture limit."
                  : "Image bytes were not captured."}
            </div>
          )}
          <span>{formatBytes(revision.size)}</span>
        </figure>
      ))}
    </div>
  );
}

function UnifiedDiff(props: { diff: string; truncated: boolean }) {
  const rows = parseUnifiedDiff(props.diff);
  const renderedRows = rows.slice(0, 5_000);
  const renderTruncated = renderedRows.length < rows.length;
  return (
    <div className="artifact-diff-wrap">
      <table className="artifact-diff" aria-label="Unified file diff">
        <tbody>
          {renderedRows.map((row, index) => (
            <tr className={`artifact-diff-line artifact-diff-line--${row.kind}`} key={`${index}:${row.text}`}>
              <td className="artifact-diff-number" aria-label={row.oldLine === undefined ? undefined : `Old line ${row.oldLine}`}>{row.oldLine ?? ""}</td>
              <td className="artifact-diff-number" aria-label={row.newLine === undefined ? undefined : `New line ${row.newLine}`}>{row.newLine ?? ""}</td>
              <td className="artifact-diff-code"><code>{row.text || " "}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.truncated ? <p className="artifact-diff-truncated">Diff truncated at the package capture limit.</p> : null}
      {renderTruncated ? <p className="artifact-diff-truncated">Preview limited to the first 5,000 diff rows.</p> : null}
    </div>
  );
}

type DiffRow = {
  kind: "add" | "delete" | "context" | "hunk" | "header";
  oldLine?: number;
  newLine?: number;
  text: string;
};

function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  const normalized = diff.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  for (const text of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text });
      continue;
    }
    if (text.startsWith("diff ") || text.startsWith("index ") || text.startsWith("--- ") || text.startsWith("+++ ") || text.startsWith("Binary files ") || text === "\\ No newline at end of file") {
      rows.push({ kind: "header", text });
      continue;
    }
    if (text.startsWith("+") && !text.startsWith("+++")) {
      rows.push({ kind: "add", newLine, text });
      newLine += 1;
      continue;
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      rows.push({ kind: "delete", oldLine, text });
      oldLine += 1;
      continue;
    }
    rows.push({ kind: "context", oldLine: oldLine || undefined, newLine: newLine || undefined, text });
    if (oldLine) oldLine += 1;
    if (newLine) newLine += 1;
  }
  return rows;
}

function StatusGlyph(props: { status: FileChangeStatus }) {
  const label = props.status === "added" ? "A" : props.status === "modified" ? "M" : "D";
  return <span className={`artifact-status artifact-status--${props.status}`} aria-label={props.status} title={props.status}>{label}</span>;
}

function StatusTally(props: { counts: ReturnType<typeof statusCounts> }) {
  const counts = props.counts;
  return (
    <span className="artifact-tally" aria-label={`${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted`}>
      {counts.added > 0 ? <span className="added">+{counts.added}</span> : null}
      {counts.modified > 0 ? <span className="modified">~{counts.modified}</span> : null}
      {counts.deleted > 0 ? <span className="deleted">-{counts.deleted}</span> : null}
    </span>
  );
}

/** Line counts when the capture stored a diff, byte weight otherwise. */
function ChangeStat(props: { change: FileChangeSummary }) {
  const stats = props.change.lineStats;
  if (stats && (stats.added > 0 || stats.deleted > 0)) {
    return (
      <span className="artifact-change-stat" title={`${stats.added} added, ${stats.deleted} removed`}>
        {stats.added > 0 ? <span className="added">+{stats.added}</span> : null}
        {stats.deleted > 0 ? <span className="deleted">−{stats.deleted}</span> : null}
      </span>
    );
  }
  const weight = byteWeight(props.change);
  return weight ? <span className="artifact-change-stat">{weight}</span> : null;
}

function byteWeight(change: FileChangeSummary): ReactNode {
  const before = change.before;
  const after = change.after;
  if (change.status === "added") return after ? <span className="added">+{formatBytes(after.size)}</span> : null;
  if (change.status === "deleted") return before ? <span className="deleted">−{formatBytes(before.size)}</span> : null;
  if (!before || !after) return after ? formatBytes(after.size) : null;
  const delta = after.size - before.size;
  if (delta === 0) return formatBytes(after.size);
  return <span className={delta > 0 ? "added" : "deleted"}>{delta > 0 ? "+" : "−"}{formatBytes(Math.abs(delta))}</span>;
}

function captureAlert(capture: FileChangeCaptureSummary): CaptureAlert | null {
  const coverage = capture.coverage;
  if (coverage.status === "unsupported") return { tone: "danger", label: "Tracking unavailable" };
  if (coverage.status === "failed") return { tone: "danger", label: "Tracking failed" };
  if (coverage.status === "partial") return { tone: "warning", label: "Partial coverage" };
  if (coverage.trackingMode === "managed-tools-only" && coverage.bashInvoked) return { tone: "warning", label: "Shell not tracked" };
  if (capture.warnings.length > 0) return { tone: "warning", label: `${capture.warnings.length} ${capture.warnings.length === 1 ? "warning" : "warnings"}` };
  return null;
}

function bashScopeNote(coverage: FileChangeCaptureSummary["coverage"]["bashCoverage"]): string {
  if (coverage === "watcher-observed") return "Filesystem events were observed without guaranteed before content or tool attribution.";
  if (coverage === "not-tracked") return "Shell changes were intentionally not tracked in managed-tools-only mode.";
  return "Legacy checkpoint coverage applied only to listed directories.";
}

function availableViews(change: FileChangeDetail): DetailView[] {
  const views: DetailView[] = [];
  if (change.unifiedDiff) views.push("diff");
  if (readableText(change.after)) views.push("after");
  if (readableText(change.before)) views.push("before");
  return views;
}

function readableText(revision: FileChangeRevision | undefined): boolean {
  return Boolean(revision && !revision.redacted && revision.encoding === "utf8" && revision.content !== undefined);
}

async function copyPath(path: string): Promise<void> {
  await getBridge().writeClipboardText(path).catch(async () => {
    await navigator.clipboard?.writeText(path).catch(() => undefined);
  });
}

function toggleMember(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return next;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function pairLabel(before: string | undefined, after: string | undefined): string | undefined {
  if (before && after) return before === after ? after : `${before} → ${after}`;
  return before ?? after;
}

function imageDataUrl(revision: FileChangeRevision): string | null {
  if (revision.redacted || revision.encoding !== "base64" || !revision.content || !revision.mediaType?.startsWith("image/")) return null;
  return `data:${revision.mediaType};base64,${revision.content}`;
}

function statusCounts(statuses: FileChangeStatus[]) {
  return statuses.reduce((counts, status) => ({ ...counts, [status]: counts[status] + 1 }), { added: 0, modified: 0, deleted: 0 });
}

function fileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) || path;
}

/**
 * Everything above the file name. Rendered right-to-left so the deepest, most
 * distinguishing segment survives when the panel is narrow.
 */
function directoryLabel(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  segments.pop();
  return segments.length === 0 ? "" : `‎${segments.join("/")}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function formatRelativeTime(value: string, now: number): string {
  const time = new Date(value).valueOf();
  if (Number.isNaN(time)) return value;
  const seconds = Math.max(Math.round((now - time) / 1000), 0);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(time).toLocaleDateString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function shortHash(value: string | undefined): string | undefined {
  return value ? `${value.slice(0, 8)}` : undefined;
}

function kindTag(kind: FileChangeKind): string {
  if (kind === "image") return "IMG";
  if (kind === "binary") return "BIN";
  return "FILE";
}

function trackingLabel(mode: FileChangeCaptureSummary["coverage"]["trackingMode"]): string {
  if (mode === "managed-tools-only") return "managed write/edit";
  if (mode === "watcher") return "watcher event";
  return "legacy checkpoint";
}

/** Keeps the relative capture times honest while the panel stays open. */
function useTicking(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}
