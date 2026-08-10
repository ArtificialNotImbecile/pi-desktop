import { useEffect, useMemo, useState } from "react";
import type {
  ChatMessage,
  FileChangeCaptureSummary,
  FileChangeDetail,
  FileChangeRevision,
  FileChangeStatus,
  ThreadArtifactsResponse
} from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";
import { useThrottledValue } from "../../hooks/useThrottledValue";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

export function ArtifactsPane(props: { threadId: string | null; messages: ChatMessage[] }) {
  const [data, setData] = useState<ThreadArtifactsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ threadId: string; changeId: string } | null>(null);
  const [detail, setDetail] = useState<{ threadId: string; changeId: string; change: FileChangeDetail } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const messages = useThrottledValue(props.messages, 1000);
  const refreshKey = `${messages.length}:${messages.at(-1)?.id ?? ""}`;

  useEffect(() => {
    setData(null);
    setListError(null);
    setSelection(null);
    setDetail(null);
    setDetailError(null);
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
  const selectionMatchesThread = selection?.threadId === props.threadId;
  const visibleDetail = selectionMatchesThread
    && detail?.threadId === props.threadId
    && detail.changeId === selection.changeId
    ? detail.change
    : null;
  if (loading && captures.length === 0) return <p className="panel-empty">Loading file changes...</p>;
  if (listError && captures.length === 0) return <p className="artifact-detail-error" role="alert">Unable to load file changes: {listError}</p>;
  if (captures.length === 0) {
    return <p className="panel-empty">No file changes captured for this chat yet.</p>;
  }

  return (
    <>
      {listError ? <p className="artifact-detail-error" role="alert">Unable to refresh file changes: {listError}</p> : null}
      <div className="right-panel-list artifact-capture-list">
        {captures.map((capture) => <CaptureGroup
          key={capture.id}
          capture={capture}
          onOpen={(changeId) => props.threadId && setSelection({ threadId: props.threadId, changeId })}
        />)}
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
        {visibleDetail ? <ArtifactDetailView change={visibleDetail} /> : null}
      </Dialog>
    </>
  );
}

function CaptureGroup(props: { capture: FileChangeCaptureSummary; onOpen(changeId: string): void }) {
  const capture = props.capture;
  const counts = statusCounts(capture.changes.map((change) => change.status));
  const complete = capture.coverage.status === "complete";
  return (
    <section className="artifact-capture" aria-label={`File changes captured ${formatTimestamp(capture.completedAt)}`}>
      <header className="artifact-capture-header">
        <div>
          <strong>{formatTimestamp(capture.completedAt)}</strong>
          <span>{capture.changes.length} changed {capture.changes.length === 1 ? "file" : "files"}</span>
        </div>
        <div className="artifact-capture-counts" aria-label="Change counts">
          {counts.added > 0 ? <span className="added">+{counts.added}</span> : null}
          {counts.modified > 0 ? <span className="modified">~{counts.modified}</span> : null}
          {counts.deleted > 0 ? <span className="deleted">-{counts.deleted}</span> : null}
        </div>
      </header>
      {!complete ? (
        <div className={`artifact-coverage artifact-coverage--${capture.coverage.status}`} role="status">
          <strong>{capture.coverage.status === "unsupported" ? "Tracking unavailable" : capture.coverage.status === "failed" ? "Tracking failed" : "Partial coverage"}</strong>
          <span>{capture.coverage.reason || "Some configured paths could not be captured."}</span>
        </div>
      ) : null}
      {capture.coverage.trackingMode === "managed-tools-only" && capture.coverage.bashInvoked ? (
        <div className="artifact-coverage" role="status">
          <strong>Shell changes not tracked</strong>
          <span>This fast mode only records approved write/edit targets. No project-wide scan was performed.</span>
        </div>
      ) : null}
      {capture.warnings.map((warning, index) => (
        <div className="artifact-warning" key={`${capture.id}:warning:${index}`}>{warning}</div>
      ))}
      <div className="artifact-change-list">
        {capture.changes.map((change) => (
          <Button
            className="artifact-change-row"
            key={change.id}
            aria-label={`Open ${change.status} file ${change.relativePath || change.path}`}
            onClick={() => props.onOpen(change.id)}
            size="sm"
            variant="quiet"
          >
            <StatusBadge status={change.status} />
            <span className="artifact-change-name">{fileName(change.relativePath || change.path)}</span>
            <code>{change.relativePath || change.path}</code>
            <span className="artifact-change-meta">
              {kindLabel(change.kind)} · {trackingLabel(capture.coverage.trackingMode)}
            </span>
          </Button>
        ))}
      </div>
      <details className="artifact-coverage-details">
        <summary>Capture coverage: {capture.coverage.status === "complete" ? trackingSummary(capture.coverage.trackingMode) : capture.coverage.status}</summary>
        {capture.coverage.rootDetails?.length ? capture.coverage.rootDetails.map((root) => (
          <div key={root.id}>
            <strong>{root.scope === "file" ? "Exact file" : root.scope === "watcher" ? "Watcher root" : "Legacy directory checkpoint"}</strong>
            <code>{root.scope === "file" ? root.requestedPath || root.requestedFilePath || root.filePath || root.path : root.path}</code>
            {root.physicalPath !== root.path ? <span>Resolved to <code>{root.physicalPath}</code></span> : null}
          </div>
        )) : (
          <div><strong>Root{capture.roots.length === 1 ? "" : "s"}</strong>{capture.roots.map((root) => <code key={root}>{root}</code>)}</div>
        )}
        {capture.coverage.bashInvoked ? <div><strong>Shell scope</strong><span>{capture.coverage.bashCoverage === "watcher-observed" ? "Filesystem events were observed without guaranteed before content or tool attribution." : capture.coverage.bashCoverage === "not-tracked" ? "Shell changes were intentionally not tracked in managed-tools-only mode." : "Legacy checkpoint coverage applied only to listed directories."}</span></div> : null}
        {capture.coverage.trackingMode === "watcher" ? <div><strong>Watcher semantics</strong><span>Event-based and fast: no initial directory scan; updates may have after-only previews.</span></div> : null}
        <div><strong>History</strong><span>Retained as run evidence; conversation edits do not roll back files.</span></div>
        {capture.excludes.length > 0 ? <div><strong>Excluded</strong><code>{capture.excludes.join(", ")}</code></div> : null}
        {capture.coverage.issues?.slice(0, 20).map((issue, index) => (
          <div key={`${issue.code}:${issue.rootId}:${issue.path ?? ""}:${index}`}><strong>{issue.code}</strong><span>{issue.message}</span></div>
        ))}
        {(capture.coverage.issues?.length ?? 0) > 20 ? <div><span>{(capture.coverage.issues?.length ?? 0) - 20} more coverage issues</span></div> : null}
        {capture.coverage.omittedIssueCount ? <div><span>{capture.coverage.omittedIssueCount} additional coverage issues omitted by the capture limit.</span></div> : null}
        {capture.coverage.omittedWarningCount ? <div><span>{capture.coverage.omittedWarningCount} additional warnings omitted by the capture limit.</span></div> : null}
      </details>
    </section>
  );
}

function ArtifactDetailView(props: { change: FileChangeDetail }) {
  const change = props.change;
  const isImage = change.kind === "image";
  return (
    <div className="artifact-detail">
      <div className="artifact-detail-meta">
        <StatusBadge status={change.status} />
        <code>{change.path}</code>
        <span>Captured without a full-directory checkpoint.</span>
      </div>
      <RevisionMetadata before={change.before} after={change.after} />
      {isImage ? (
        <ImageChangePreview before={change.before} after={change.after} status={change.status} />
      ) : change.unifiedDiff ? (
        <UnifiedDiff diff={change.unifiedDiff} truncated={change.diffTruncated} />
      ) : (
        <SnapshotFallback change={change} />
      )}
    </div>
  );
}

function RevisionMetadata(props: { before?: FileChangeRevision; after?: FileChangeRevision }) {
  if (!props.before && !props.after) return null;
  const rows = [
    { label: "Mode", before: props.before?.mode, after: props.after?.mode },
    { label: "Size", before: props.before ? formatBytes(props.before.size) : undefined, after: props.after ? formatBytes(props.after.size) : undefined },
    { label: "SHA-256", before: shortHash(props.before?.sha256), after: shortHash(props.after?.sha256) }
  ];
  return (
    <table className="artifact-revision-metadata" aria-label="File revision metadata">
      <thead><tr><th>Property</th><th>Before</th><th>After</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}><th scope="row">{row.label}</th><td><code>{row.before ?? "—"}</code></td><td><code>{row.after ?? "—"}</code></td></tr>
        ))}
      </tbody>
    </table>
  );
}

function SnapshotFallback(props: { change: FileChangeDetail }) {
  const revision = props.change.status === "deleted" ? props.change.before : props.change.after ?? props.change.before;
  if (revision?.redacted) {
    return <p className="artifact-preview-unavailable">Content and diff were redacted because the path may contain secrets.</p>;
  }
  if (revision?.encoding === "utf8" && revision.content !== undefined) {
    return (
      <div className="artifact-text-snapshot">
        <header>{props.change.status === "deleted" ? "Before deletion" : "File content"}</header>
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

function StatusBadge(props: { status: FileChangeStatus }) {
  const label = props.status === "added" ? "A" : props.status === "modified" ? "M" : "D";
  return <span className={`artifact-status artifact-status--${props.status}`} aria-label={props.status} title={props.status}>{label}</span>;
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

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function shortHash(value: string | undefined): string | undefined {
  return value ? `${value.slice(0, 12)}…` : undefined;
}

function kindLabel(kind: FileChangeDetail["kind"]): string {
  if (kind === "text") return "Text";
  if (kind === "image") return "Image";
  if (kind === "binary") return "Binary";
  return "File";
}

function trackingLabel(mode: FileChangeCaptureSummary["coverage"]["trackingMode"]): string {
  if (mode === "managed-tools-only") return "managed write/edit";
  if (mode === "watcher") return "watcher event";
  return "legacy checkpoint";
}

function trackingSummary(mode: FileChangeCaptureSummary["coverage"]["trackingMode"]): string {
  if (mode === "managed-tools-only") return "managed write/edit targets only";
  if (mode === "watcher") return "watcher events plus managed targets";
  return "complete for listed legacy roots";
}
