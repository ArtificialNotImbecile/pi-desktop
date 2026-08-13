import { useMemo, useState, type SyntheticEvent } from "react";
import type {
  ContextReasoningValidation,
  ContextTaxonomy,
  ContextTaxonomyItem,
  ContextTaxonomyKind,
  ContextTaxonomyPart,
  ContextTaxonomyPartKind
} from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";
import { looksLikeJson, ShikiCodeBlock } from "../code";
import { ChevronRightIcon } from "../icons/Icons";
import { Button } from "../ui";
import { MarkdownMessage } from "./MarkdownMessage";

/**
 * Context taxonomy panel.
 *
 * The panel has three zones, and every visual decision follows from which zone
 * a thing belongs to: an identity header, one budget card that owns every
 * diagnostic, and the content tree. Depth in the tree reads as group -> item ->
 * part -> body, and gets *lighter* with depth: only the leaf body carries a box.
 *
 * Colour means exactly one thing here -- which bucket a span of context falls
 * into -- and it is shared by the composition bar, the legend, the item rail,
 * and the part tag. That is what lets the per-item kind pills go away without
 * losing the information they carried.
 */

/** Display buckets. Coarser than `ContextTaxonomyKind` so the legend stays readable. */
type ContextBucket =
  | "instructions"
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_definition"
  | "tool_result"
  | "attachment"
  | "options"
  | "unknown";

type CompositionItem = { bucket: ContextBucket; label: string; tokens: number; percent: number };

type ResolvedPart = {
  key: string;
  bucket: ContextBucket;
  tag: string;
  title: string;
  text: string;
  format: ContextTaxonomyPart["format"];
  tokenEstimate: number;
  payloadPath?: string;
  toolName?: string;
  toolCallId?: string;
  isReasoning: boolean;
};

type ResolvedItem = {
  key: string;
  item: ContextTaxonomyItem;
  title: string;
  bucket: ContextBucket;
  parts: ResolvedPart[];
  /**
   * Set when the item's one part says nothing its header does not already say,
   * so the body renders directly and the part row is chrome worth dropping.
   * Its JSONPath is more specific than the item's, so the meta line takes it.
   */
  single: ResolvedPart | null;
  /**
   * Message envelope fields (role, tool name, tool call id) that the classifier
   * emits as `metadata` parts. They still count toward the item and the
   * composition -- the panel must account for the whole payload -- but as tree
   * rows they are one content-free line per message, so they are folded into
   * the meta line instead.
   */
  foldedCount: number;
  tokenEstimate: number;
  meta: string[];
  path: string;
  buckets: Set<ContextBucket>;
  searchText: string;
};

type ResolvedGroup = { id: string; label: string; items: ResolvedItem[]; tokenEstimate: number };

type CaptureOption = { id: string; requestIndex: number; requestCount: number };

export function TaxonomyView(props: {
  taxonomy: ContextTaxonomy;
  captureId: string;
  captures?: CaptureOption[];
  onSelectCapture?(captureId: string): void;
}) {
  const taxonomy = props.taxonomy;
  const validation = taxonomy.reasoningValidation;
  const reasoningFailed = validation?.status === "fail";

  const groups = useMemo(() => buildGroups(taxonomy), [taxonomy]);
  const estimatedTotal = useMemo(() => groups.reduce((total, group) => total + group.tokenEstimate, 0), [groups]);
  const composition = useMemo(() => buildComposition(groups, estimatedTotal), [groups, estimatedTotal]);
  const unclassifiedPaths = useMemo(() => collectUnclassifiedPaths(taxonomy), [taxonomy]);

  const [query, setQuery] = useState("");
  const [bucketFilter, setBucketFilter] = useState<ContextBucket | null>(null);
  const [openItems, setOpenItems] = useState<Set<string>>(() => defaultOpenItems(groups, reasoningFailed));
  const [openParts, setOpenParts] = useState<Set<string>>(() => defaultOpenParts(groups, reasoningFailed));
  const [allExpanded, setAllExpanded] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleGroups = useMemo(
    () => filterGroups(groups, normalizedQuery, bucketFilter),
    [groups, normalizedQuery, bucketFilter]
  );
  const visibleCount = visibleGroups.reduce((total, group) => total + group.items.length, 0);
  const filtered = normalizedQuery.length > 0 || bucketFilter !== null;

  const toggleAll = () => {
    const expanding = !allExpanded;
    setAllExpanded(expanding);
    if (!expanding) {
      setOpenItems(new Set());
      setOpenParts(new Set());
      return;
    }
    setOpenItems(new Set(groups.flatMap((group) => group.items.map((item) => item.key))));
    setOpenParts(new Set(groups.flatMap((group) => group.items.flatMap((item) => item.parts.map((part) => part.key)))));
  };

  return (
    <div className="taxonomy-view">
      <TaxonomyHeader
        taxonomy={taxonomy}
        captures={props.captures}
        captureId={props.captureId}
        onSelectCapture={props.onSelectCapture}
      />

      <TaxonomyBudget
        taxonomy={taxonomy}
        composition={composition}
        estimatedTotal={estimatedTotal}
        unclassifiedPaths={unclassifiedPaths}
        bucketFilter={bucketFilter}
        onBucketFilter={setBucketFilter}
      />

      <div className="taxonomy-toolbar">
        <input
          className="taxonomy-filter"
          type="search"
          value={query}
          placeholder="Filter items and paths"
          aria-label="Filter context items and payload paths"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="taxonomy-toolbar-button" onClick={toggleAll}>
          {allExpanded ? "Collapse all" : "Expand all"}
        </button>
      </div>

      <div className="taxonomy-tree" aria-label="Derived context taxonomy">
        {visibleGroups.map((group) => (
          <section key={group.id} className="taxonomy-group" aria-label={group.label}>
            <div className="taxonomy-group-head">
              <span className="taxonomy-group-name">{group.label}</span>
              <span className="taxonomy-group-count">{group.items.length}</span>
              <span className="taxonomy-group-percent">{formatPercent(group.tokenEstimate, estimatedTotal)}</span>
            </div>
            {group.items.map((resolved) => (
              <TaxonomyItemView
                key={resolved.key}
                resolved={resolved}
                open={openItems.has(resolved.key)}
                openParts={openParts}
                onToggle={(open) => setOpenItems((current) => toggled(current, resolved.key, open))}
                onTogglePart={(partKey, open) => setOpenParts((current) => toggled(current, partKey, open))}
              />
            ))}
          </section>
        ))}
        {visibleCount === 0 && (
          <p className="taxonomy-empty">
            {filtered ? "No context items match this filter." : "This capture recorded no derived items."}
          </p>
        )}
        <RawPayload captureId={props.captureId} taxonomy={taxonomy} />
      </div>
    </div>
  );
}

function TaxonomyHeader(props: {
  taxonomy: ContextTaxonomy;
  captures?: CaptureOption[];
  captureId: string;
  onSelectCapture?(captureId: string): void;
}) {
  const taxonomy = props.taxonomy;
  const [copied, setCopied] = useState(false);
  const captures = props.captures ?? [];
  const approximate = taxonomy.source === "jasmine-assembly";

  const copyHash = async () => {
    if (!taxonomy.payloadHash) return;
    await getBridge().writeClipboardText(taxonomy.payloadHash).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <header className="taxonomy-head">
      <div className="taxonomy-head-id">
        <strong title={`${taxonomy.provider}/${taxonomy.model}`}>{taxonomy.provider}/{taxonomy.model}</strong>
        {approximate && <span className="taxonomy-head-approximate">approximate</span>}
        {captures.length > 1 && props.onSelectCapture && (
          <div className="taxonomy-request-switcher" role="group" aria-label="Provider request">
            {captures.map((capture) => (
              <button
                key={capture.id}
                type="button"
                aria-pressed={capture.id === props.captureId}
                aria-label={`Request ${capture.requestIndex} of ${capture.requestCount}`}
                onClick={() => props.onSelectCapture?.(capture.id)}
              >
                {capture.requestIndex}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="taxonomy-head-meta">
        <span>{taxonomy.source === "provider-payload" ? "provider payload" : "reconstructed"}</span>
        <span className="taxonomy-head-dot">·</span>
        <span>v{taxonomy.payloadSchemaVersion ?? 1}</span>
        <span className="taxonomy-head-dot">·</span>
        <span>{formatCapturedAt(taxonomy.capturedAt)}</span>
        {taxonomy.payloadHash && (
          <>
            <span className="taxonomy-head-dot">·</span>
            <button
              type="button"
              className="taxonomy-head-hash"
              title="Copy the full sha256 of the sanitized payload"
              onClick={() => void copyHash()}
            >
              {copied ? "copied" : taxonomy.payloadHash.slice(0, 12)}
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function TaxonomyBudget(props: {
  taxonomy: ContextTaxonomy;
  composition: CompositionItem[];
  estimatedTotal: number;
  unclassifiedPaths: string[];
  bucketFilter: ContextBucket | null;
  onBucketFilter(bucket: ContextBucket | null): void;
}) {
  const taxonomy = props.taxonomy;
  const metrics = taxonomy.cacheMetrics;
  const validation = taxonomy.reasoningValidation;
  const actualInput = metrics?.inputTokens;
  const primary = actualInput ?? props.estimatedTotal;
  const [openChips, setOpenChips] = useState<Set<string>>(new Set());

  const toggleChip = (id: string) => setOpenChips((current) => toggled(current, id, !current.has(id)));
  const chipProps = (id: string) => ({
    type: "button" as const,
    className: "taxonomy-chip",
    "aria-expanded": openChips.has(id),
    onClick: () => toggleChip(id)
  });

  return (
    <section className="taxonomy-budget" aria-label="Context budget">
      <div className="taxonomy-total">
        <b className="taxonomy-total-value">{primary.toLocaleString()}</b>
        <span className="taxonomy-total-label">{actualInput === undefined ? "estimated input tokens" : "actual input tokens"}</span>
        {actualInput !== undefined && (
          <em className="taxonomy-total-estimate">
            est. {props.estimatedTotal.toLocaleString()}
            {actualInput > 0 && ` · ${formatDelta(props.estimatedTotal, actualInput)}`}
          </em>
        )}
      </div>

      {props.composition.length > 0 && (
        <>
          <div className="taxonomy-bar" aria-hidden="true">
            {props.composition.map((entry) => (
              <span
                key={entry.bucket}
                className={props.bucketFilter && props.bucketFilter !== entry.bucket ? "dimmed" : ""}
                style={{ width: `${Math.max(1, entry.percent)}%`, background: bucketColor(entry.bucket) }}
              />
            ))}
          </div>
          <ul className="taxonomy-legend" aria-label="Estimated context composition">
            {props.composition.map((entry) => (
              <li key={entry.bucket}>
                <button
                  type="button"
                  aria-pressed={props.bucketFilter === entry.bucket}
                  onClick={() => props.onBucketFilter(props.bucketFilter === entry.bucket ? null : entry.bucket)}
                >
                  <i style={{ background: bucketColor(entry.bucket) }} aria-hidden="true" />
                  <span className="taxonomy-legend-label">{entry.label}</span>
                  <span className="taxonomy-legend-value">{entry.tokens.toLocaleString()}</span>
                  <span className="taxonomy-legend-percent">{Math.round(entry.percent)}%</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="taxonomy-status">
        {taxonomy.source === "jasmine-assembly" && (
          <button {...chipProps("assembly")} data-tone="bad">Reconstructed approximation</button>
        )}
        {metrics && (
          <button {...chipProps("cache")} data-tone={metrics.cacheHitTokens > 0 ? "ok" : "neutral"}>
            Cache {Math.round(metrics.hitRate * 1000) / 10}% hit
          </button>
        )}
        {validation && (
          <button {...chipProps("reasoning")} data-tone={validationTone(validation.status)}>
            Reasoning {validationStatusLabel(validation.status)}
          </button>
        )}
        {props.unclassifiedPaths.length > 0 && (
          <button {...chipProps("unclassified")} data-tone="bad">
            {props.unclassifiedPaths.length} unknown {props.unclassifiedPaths.length === 1 ? "field" : "fields"}
          </button>
        )}
      </div>

      {openChips.has("assembly") && (
        <div className="taxonomy-status-detail" aria-label="Reconstructed context taxonomy warning">
          <strong>The exact provider payload was unavailable</strong>
          <span>This taxonomy was reassembled from what Jasmine sent, so some context parts may be missing.</span>
          {taxonomy.assemblyReason && <code>reason: {taxonomy.assemblyReason}</code>}
        </div>
      )}
      {openChips.has("cache") && metrics && (
        <div className="taxonomy-status-detail" aria-label="Provider cache evidence">
          <div className="taxonomy-kv"><span>Cache hit</span><b>{metrics.cacheHitTokens.toLocaleString()}</b></div>
          <div className="taxonomy-kv"><span>Cache miss</span><b>{metrics.cacheMissTokens.toLocaleString()}</b></div>
          <div className="taxonomy-kv"><span>Cache write</span><b>{metrics.cacheWriteTokens.toLocaleString()}</b></div>
          <div className="taxonomy-kv"><span>Output</span><b>{metrics.outputTokens.toLocaleString()}</b></div>
          <span>{metrics.note}</span>
        </div>
      )}
      {openChips.has("reasoning") && validation && (
        <div className="taxonomy-status-detail" aria-label="Reasoning retention validation">
          <strong>{policyLabel(validation.policyId)}</strong>
          <span>{validation.summary}</span>
          {validation.requiredCount > 0 && (
            <div className="taxonomy-kv"><span>Required blocks present</span><b>{validation.sentCount}/{validation.requiredCount}</b></div>
          )}
          {validation.policySource && <a href={validation.policySource} target="_blank" rel="noreferrer">Provider policy</a>}
        </div>
      )}
      {openChips.has("unclassified") && (
        <div className="taxonomy-status-detail" aria-label="Unclassified provider payload warning">
          <strong>No classifier rule matched these fields</strong>
          <span>They are kept with exact JSONPaths and source-relative order. Add a classifier rule if they carry model context.</span>
          <code>
            {props.unclassifiedPaths.slice(0, 6).join(" · ")}
            {props.unclassifiedPaths.length > 6 ? ` · +${props.unclassifiedPaths.length - 6} more` : ""}
          </code>
        </div>
      )}
    </section>
  );
}

function TaxonomyItemView(props: {
  resolved: ResolvedItem;
  open: boolean;
  openParts: Set<string>;
  onToggle(open: boolean): void;
  onTogglePart(partKey: string, open: boolean): void;
}) {
  const resolved = props.resolved;
  const single = resolved.single;

  return (
    <details
      className="taxonomy-item"
      style={{ "--taxonomy-kind-color": bucketColor(resolved.bucket) } as Record<string, string>}
      open={props.open}
      onToggle={(event) => props.onToggle(event.currentTarget.open)}
    >
      <summary className="taxonomy-item-head">
        <span className="taxonomy-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        <span className="taxonomy-item-title" title={resolved.title}>{resolved.title}</span>
        <span className="taxonomy-item-tokens">{resolved.tokenEstimate.toLocaleString()}</span>
      </summary>
      <div className="taxonomy-item-body">
        <div className="taxonomy-item-meta">
          {resolved.meta.map((entry, index) => <span key={`${entry}-${index}`}>{entry}</span>)}
          <PayloadPath path={resolved.path} />
        </div>
        {single
          ? <RenderedBody text={single.text} format={single.format} title={single.title} />
          : resolved.parts.length > 0
            ? (
              <div className="taxonomy-parts">
                {resolved.parts.map((part) => (
                  <TaxonomyPartView
                    key={part.key}
                    part={part}
                    open={props.openParts.has(part.key)}
                    onToggle={(open) => props.onTogglePart(part.key, open)}
                  />
                ))}
              </div>
            )
            : <RenderedBody
                text={resolved.item.text ?? resolved.item.preview}
                format={looksLikeJson(resolved.item.text ?? "") ? "json" : "markdown"}
                title={resolved.title}
              />}
      </div>
    </details>
  );
}

function TaxonomyPartView(props: { part: ResolvedPart; open: boolean; onToggle(open: boolean): void }) {
  const part = props.part;
  return (
    <details
      className="taxonomy-part"
      style={{ "--taxonomy-kind-color": bucketColor(part.bucket) } as Record<string, string>}
      open={props.open}
      onToggle={(event) => props.onToggle(event.currentTarget.open)}
    >
      <summary className="taxonomy-part-head">
        <span className="taxonomy-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        <code className="taxonomy-tag">{part.tag}</code>
        <span className="taxonomy-part-title" title={part.title}>{part.toolName ?? part.title}</span>
        <span className="taxonomy-part-tokens">{part.tokenEstimate.toLocaleString()}</span>
      </summary>
      <div className="taxonomy-part-body">
        {(part.payloadPath || part.toolCallId) && (
          <div className="taxonomy-part-meta">
            {part.toolCallId && <span>{part.toolCallId}</span>}
            {part.payloadPath && <PayloadPath path={part.payloadPath} />}
          </div>
        )}
        <RenderedBody text={part.text} format={part.format} title={part.title} />
      </div>
    </details>
  );
}

/**
 * A JSONPath's tail identifies it and the panel is often only wide enough for
 * one end, so the box truncates from the left (`direction: rtl` in the CSS).
 * That reorders the leading `$.`, which the bidi algorithm reads as neutral, to
 * the far end -- `$.tools[0]` renders as `tools[0].$`. Isolating the path keeps
 * its own left-to-right order while the box still drops the head.
 */
function PayloadPath(props: { path: string }) {
  return <span className="taxonomy-path"><bdi>{props.path}</bdi></span>;
}

function RenderedBody(props: { text: string; format: "text" | "markdown" | "json"; title: string }) {
  if (props.format === "json") return <ShikiCodeBlock code={props.text} language="json" kind="json" title={props.title} />;
  return (
    <div className="taxonomy-body">
      <MarkdownMessage content={props.text} onCopyCode={(text) => { void getBridge().writeClipboardText(text); }} />
    </div>
  );
}

function RawPayload(props: { captureId: string; taxonomy: ContextTaxonomy }) {
  const [text, setText] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const shape = props.taxonomy.payloadShape;

  const loadMore = async () => {
    if (loading || done || props.taxonomy.rawState === "unavailable") return;
    setLoading(true);
    setError(null);
    try {
      const response = await getBridge().getContextTaxonomyRaw({ captureId: props.captureId, offset: text.length, length: 65_536 });
      setText((current) => current + response.text);
      setDone(response.done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open && !text && !done) void loadMore();
  };

  const copyFull = async () => {
    setLoading(true);
    setError(null);
    try {
      let offset = 0;
      let complete = false;
      const chunks: string[] = [];
      while (!complete) {
        const response = await getBridge().getContextTaxonomyRaw({ captureId: props.captureId, offset, length: 65_536 });
        chunks.push(response.text);
        offset += response.text.length;
        complete = response.done || response.text.length === 0;
      }
      await getBridge().writeClipboardText(chunks.join(""));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  return (
    <details className="taxonomy-raw-payload" onToggle={onToggle}>
      <summary className="taxonomy-raw-head">
        <span className="taxonomy-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        <span className="taxonomy-raw-label">
          <strong>Sanitized raw payload</strong>
          <small>
            {rawStateLabel(props.taxonomy.rawState)} · {(props.taxonomy.rawByteCount ?? 0).toLocaleString()} bytes
            {shape && shape.topLevelOrder.length > 0 ? ` · ${shape.topLevelOrder.join(" → ")}` : ""}
          </small>
        </span>
        <Button
          size="sm"
          variant="quiet"
          disabled={props.taxonomy.rawState === "unavailable" || loading}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); void copyFull(); }}
        >
          {copied ? "Copied" : "Copy full"}
        </Button>
      </summary>
      <div className="taxonomy-raw-body">
        {shape && shape.topLevelOrder.length > 0 && (
          <div className="taxonomy-raw-shape">
            <span>{shape.messageCount ?? 0} messages · {shape.toolCount ?? 0} tools · exact wire order</span>
            <div className="taxonomy-payload-order">
              {shape.topLevelOrder.map((key, index) => (
                <span key={`${key}-${index}`}>{index > 0 && <i aria-hidden="true">→</i>}<code>{key}</code></span>
              ))}
            </div>
          </div>
        )}
        {error && <p className="taxonomy-raw-error">{error}</p>}
        {text && <ShikiCodeBlock code={text} language="json" kind="json" title="sanitized provider payload" />}
        {!done && props.taxonomy.rawState !== "unavailable" && (
          <Button className="taxonomy-load-more" size="sm" variant="quiet" loading={loading} onClick={() => void loadMore()}>
            {loading ? "Loading…" : "Load next 64 KiB"}
          </Button>
        )}
        {props.taxonomy.rawState === "unavailable" && (
          <p className="taxonomy-raw-error">Raw payload was not available for this legacy or reconstructed capture.</p>
        )}
      </div>
    </details>
  );
}

/* ---------------------------------------------------------------- model --- */

const GROUP_ORDER: Array<{ id: string; label: string; kinds: ContextTaxonomyKind[] }> = [
  { id: "instructions", label: "Instructions", kinds: ["system_prompt", "developer_instructions", "project_context", "skill_manifest", "skill_instructions", "prompt_template", "memory"] },
  { id: "conversation", label: "Conversation", kinds: ["conversation_history", "provider_message", "attachment"] },
  { id: "prompt", label: "Current prompt", kinds: ["current_user_prompt"] },
  { id: "tools", label: "Tools", kinds: ["tool_definition"] },
  { id: "options", label: "Request options", kinds: ["provider_options"] },
  { id: "unknown", label: "Unknown fields", kinds: ["unclassified", "unknown", "raw_payload"] }
];

/** Kinds whose parts describe message content rather than a payload section. */
const MESSAGE_KINDS = new Set<ContextTaxonomyKind>([
  "system_prompt", "developer_instructions", "conversation_history", "current_user_prompt", "attachment", "provider_message"
]);

export function buildGroups(taxonomy: ContextTaxonomy): ResolvedGroup[] {
  const resolved = taxonomy.items.map((item) => resolveItem(item));
  return GROUP_ORDER.map((group) => {
    const items = resolved.filter((entry) => group.kinds.includes(entry.item.kind ?? fallbackKind(entry.item.role)));
    return {
      id: group.id,
      label: group.label,
      items,
      tokenEstimate: items.reduce((total, entry) => total + entry.tokenEstimate, 0)
    };
  }).filter((group) => group.items.length > 0);
}

function resolveItem(item: ContextTaxonomyItem): ResolvedItem {
  const kind = item.kind ?? fallbackKind(item.role);
  const key = `${item.order}-${item.payloadPath ?? item.source}`;
  const segments = item.segments ?? [];
  const parts = item.parts ?? [];
  // Instruction text is split by the segment classifier, not by wire parts, so
  // a system prompt still breaks down into project context, skills and memory.
  const useSegments = (item.role === "system" || item.role === "developer") && segments.length > 1;

  const resolvedParts: ResolvedPart[] = [];
  let foldedTokens = 0;
  let foldedCount = 0;

  const message = MESSAGE_KINDS.has(kind);
  const resolvePart = (part: ContextTaxonomyPart): ResolvedPart => ({
    key: `${key}:p${part.order}-${part.payloadPath ?? part.title}`,
    // Sections that are not messages -- tool definitions, request options,
    // unknown fields -- describe themselves with `metadata` parts. Reading
    // those by part kind filed a whole tool catalogue under "Metadata", so
    // their parts inherit the section's own bucket instead.
    bucket: message ? bucketForPartKind(part.kind, kind) : bucketForKind(kind),
    tag: part.kind,
    title: part.title,
    text: part.text,
    format: part.format,
    tokenEstimate: part.tokenEstimate,
    payloadPath: part.payloadPath,
    toolName: part.toolName,
    toolCallId: part.toolCallId,
    isReasoning: part.kind === "reasoning"
  });

  if (useSegments) {
    for (const [index, segment] of segments.entries()) {
      resolvedParts.push({
        key: `${key}:s${index}`,
        bucket: bucketForKind(segment.kind),
        tag: segment.kind,
        title: segment.title,
        text: segment.text,
        format: looksLikeJson(segment.text) ? "json" : "markdown",
        tokenEstimate: segment.tokenEstimate,
        isReasoning: false
      });
    }
    // The segments re-split this message's own text, so its `text` part is
    // already on screen. Its sibling wire fields are not, and dropping them
    // would let the unknown-field chip name a path the tree cannot show.
    for (const part of parts) {
      if (part.kind === "metadata") {
        foldedTokens += part.tokenEstimate;
        foldedCount += 1;
      } else if (part.kind === "unclassified") {
        resolvedParts.push(resolvePart(part));
      }
    }
  } else {
    for (const part of parts) {
      if (message && part.kind === "metadata") {
        foldedTokens += part.tokenEstimate;
        foldedCount += 1;
        continue;
      }
      resolvedParts.push(resolvePart(part));
    }
  }

  const partTokens = resolvedParts.reduce((total, part) => total + part.tokenEstimate, 0);
  const tokenEstimate = resolvedParts.length > 0 || foldedCount > 0 ? partTokens + foldedTokens : item.tokenEstimate;

  const only = resolvedParts.length === 1 ? resolvedParts[0] : null;
  const single = only && only.bucket === bucketForKind(kind) && !only.toolName && !only.toolCallId ? only : null;

  const meta: string[] = [item.role];
  if (foldedCount > 0) meta.push(`+${foldedCount} envelope ${foldedCount === 1 ? "field" : "fields"}`);
  const path = single?.payloadPath ?? item.payloadPath ?? item.source;

  const buckets = new Set<ContextBucket>([bucketForKind(kind), ...resolvedParts.map((part) => part.bucket)]);
  const title = itemTitle(item, kind);

  return {
    key,
    item,
    title,
    bucket: bucketForKind(kind),
    parts: resolvedParts,
    single,
    foldedCount,
    tokenEstimate,
    meta,
    path,
    buckets,
    // The filter is labelled for items *and paths*, so a nested part path such
    // as $.messages[0].content[1] has to match even though only the item's own
    // path is on screen while the item is collapsed.
    searchText: [title, item.label, item.role, item.payloadPath ?? item.source, kind, path,
      ...resolvedParts.map((part) => `${part.tag} ${part.title} ${part.toolName ?? ""} ${part.payloadPath ?? ""}`)]
      .join(" ")
      .toLowerCase()
  };
}

export function buildComposition(groups: ResolvedGroup[], total: number): CompositionItem[] {
  const values = new Map<ContextBucket, number>();
  const add = (bucket: ContextBucket, tokens: number) => values.set(bucket, (values.get(bucket) ?? 0) + tokens);

  for (const group of groups) {
    for (const resolved of group.items) {
      if (resolved.parts.length === 0) {
        add(resolved.bucket, resolved.tokenEstimate);
        continue;
      }
      const partTokens = resolved.parts.reduce((sum, part) => sum + part.tokenEstimate, 0);
      for (const part of resolved.parts) add(part.bucket, part.tokenEstimate);
      // Envelope fields are folded out of the tree but still sent to the
      // provider, so the buckets have to keep adding up to the whole payload.
      if (resolved.tokenEstimate > partTokens) add("options", resolved.tokenEstimate - partTokens);
    }
  }

  return Array.from(values.entries())
    .filter(([, tokens]) => tokens > 0)
    .map(([bucket, tokens]) => ({ bucket, label: bucketLabel(bucket), tokens, percent: total ? tokens / total * 100 : 0 }))
    .sort((left, right) => right.tokens - left.tokens);
}

function filterGroups(groups: ResolvedGroup[], query: string, bucket: ContextBucket | null): ResolvedGroup[] {
  if (!query && !bucket) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => (!bucket || item.buckets.has(bucket)) && (!query || item.searchText.includes(query)))
    }))
    .filter((group) => group.items.length > 0);
}

function defaultOpenItems(groups: ResolvedGroup[], reasoningFailed: boolean): Set<string> {
  const open = new Set<string>();
  for (const group of groups) {
    for (const item of group.items) {
      // The panel opens as a map, not a dump: only the turn the user just sent,
      // plus anything a failed reasoning-retention check needs them to see.
      if (item.item.kind === "current_user_prompt") open.add(item.key);
      if (reasoningFailed && item.parts.some((part) => part.isReasoning)) open.add(item.key);
    }
  }
  return open;
}

function defaultOpenParts(groups: ResolvedGroup[], reasoningFailed: boolean): Set<string> {
  const open = new Set<string>();
  if (!reasoningFailed) return open;
  for (const group of groups) {
    for (const item of group.items) {
      for (const part of item.parts) if (part.isReasoning) open.add(part.key);
    }
  }
  return open;
}

function toggled(current: Set<string>, key: string, open: boolean): Set<string> {
  if (current.has(key) === open) return current;
  const next = new Set(current);
  if (open) next.add(key);
  else next.delete(key);
  return next;
}

function collectUnclassifiedPaths(taxonomy: ContextTaxonomy): string[] {
  const paths = new Set<string>();
  for (const item of taxonomy.items) {
    const unclassifiedParts = (item.parts ?? []).filter((part) => part.kind === "unclassified");
    // A v7 top-level unclassified item is a section container at "$". Count
    // its field parts, not the container itself, so one unknown field is one
    // warning rather than "$" plus that field.
    if (item.kind === "unclassified" && unclassifiedParts.length === 0) {
      paths.add(item.payloadPath ?? item.source);
    }
    for (const part of unclassifiedParts) paths.add(part.payloadPath ?? `${item.payloadPath ?? item.source}:${part.order}`);
  }
  return Array.from(paths);
}

/* ---------------------------------------------------------------- labels --- */

function itemTitle(item: ContextTaxonomyItem, kind: ContextTaxonomyKind): string {
  if (kind === "tool_definition") return item.label.replace(/^Tool definitions?:?\s*/i, "");
  if (kind === "provider_options") return "Request options";
  if (kind === "unclassified" && item.role === "unclassified" && item.payloadPath === "$") return "Other payload fields";
  if (kind === "current_user_prompt") return "Current user prompt";
  if (kind === "system_prompt") return "System prompt";
  if (kind === "developer_instructions") return "Developer instructions";
  if (kind === "conversation_history" || kind === "provider_message") return `${capitalize(item.role)} turn`;
  return item.label || item.role;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function fallbackKind(role: string): ContextTaxonomyKind {
  if (role === "system") return "system_prompt";
  if (role === "developer") return "developer_instructions";
  if (role === "tool_definition") return "tool_definition";
  if (role === "request_options") return "provider_options";
  if (role === "unclassified") return "unclassified";
  return "conversation_history";
}

function bucketForKind(kind: ContextTaxonomyKind): ContextBucket {
  switch (kind) {
    case "system_prompt":
    case "developer_instructions":
    case "project_context":
    case "skill_manifest":
    case "skill_instructions":
    case "prompt_template":
    case "memory":
      return "instructions";
    case "current_user_prompt":
    case "conversation_history":
    case "provider_message":
      return "text";
    case "tool_definition":
      return "tool_definition";
    case "attachment":
      return "attachment";
    case "provider_options":
      return "options";
    default:
      return "unknown";
  }
}

function bucketForPartKind(kind: ContextTaxonomyPartKind, itemKind: ContextTaxonomyKind): ContextBucket {
  switch (kind) {
    case "reasoning": return "reasoning";
    case "tool_call": return "tool_call";
    case "tool_result": return "tool_result";
    case "attachment": return "attachment";
    case "metadata": return "options";
    case "unclassified": return "unknown";
    case "refusal": return "text";
    case "text": return itemKind === "system_prompt" || itemKind === "developer_instructions" ? "instructions" : "text";
    default: return "text";
  }
}

function bucketLabel(bucket: ContextBucket): string {
  const labels: Record<ContextBucket, string> = {
    instructions: "Instructions",
    text: "Text",
    reasoning: "Reasoning",
    tool_call: "Tool calls",
    tool_definition: "Tool definitions",
    tool_result: "Tool results",
    attachment: "Attachments",
    options: "Options & metadata",
    unknown: "Unknown"
  };
  return labels[bucket];
}

function bucketColor(bucket: ContextBucket): string {
  return `var(--kind-${bucket.replace(/_/g, "-")})`;
}

function formatPercent(value: number, total: number): string {
  return total > 0 ? `${Math.round(value / total * 100)}%` : "0%";
}

function formatDelta(estimate: number, actual: number): string {
  const delta = (estimate - actual) / actual * 100;
  const rounded = Math.round(delta * 10) / 10;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(1)}%`;
}

function formatCapturedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function validationStatusLabel(status: ContextReasoningValidation["status"]): string {
  return ({ pass: "kept", fail: "dropped", not_applicable: "n/a", unknown: "unknown" } as const)[status];
}

function validationTone(status: ContextReasoningValidation["status"]): string {
  if (status === "fail") return "bad";
  if (status === "pass") return "ok";
  return "neutral";
}

function policyLabel(policy: ContextReasoningValidation["policyId"]): string {
  return ({
    "deepseek-tool-interval-v1": "DeepSeek tool-interval policy",
    "kimi-k3-preserved-v1": "Kimi K3 preserved thinking",
    "kimi-k2.7-preserved-v1": "Kimi K2.7 preserved thinking",
    "kimi-k2.6-configurable-v1": "Kimi K2.6 configurable thinking",
    "kimi-k2.5-unsupported-v1": "Kimi K2.5",
    unknown: "Unregistered policy"
  } as const)[policy];
}

function rawStateLabel(state: ContextTaxonomy["rawState"]): string {
  if (state === "legacy_truncated") return "truncated";
  if (state === "unavailable") return "unavailable";
  return "complete";
}
