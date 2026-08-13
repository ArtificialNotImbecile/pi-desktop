import { memo, useMemo, useState, type SyntheticEvent } from "react";
import type {
  AppLanguage,
  ContextReasoningValidation,
  ContextTaxonomy,
  ContextTaxonomyItem,
  ContextTaxonomyKind,
  ContextTaxonomyPart,
  ContextTaxonomyPartKind
} from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";
import { localeTag, translate, useI18n } from "../../i18n";
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

export const TaxonomyView = memo(function TaxonomyView(props: {
  taxonomy: ContextTaxonomy;
  captureId: string;
  captures?: CaptureOption[];
  onSelectCapture?(captureId: string): void;
}) {
  recordHarnessRender();
  const { t } = useI18n();
  const taxonomy = props.taxonomy;
  const validation = taxonomy.reasoningValidation;
  const reasoningFailed = validation?.status === "fail";

  const groups = useMemo(() => buildGroups(taxonomy, t), [taxonomy, t]);
  const estimatedTotal = useMemo(() => groups.reduce((total, group) => total + group.tokenEstimate, 0), [groups]);
  const composition = useMemo(() => buildComposition(groups, estimatedTotal, t), [groups, estimatedTotal, t]);
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
          placeholder={t("taxonomy.filterPlaceholder")}
          aria-label={t("taxonomy.filterAria")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="taxonomy-toolbar-button" onClick={toggleAll}>
          {allExpanded ? t("taxonomy.collapseAll") : t("taxonomy.expandAll")}
        </button>
      </div>

      <div className="taxonomy-tree" aria-label={t("taxonomy.treeAria")}>
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
});

function recordHarnessRender(): void {
  if (typeof window === "undefined" || !window.__JASMINE_HARNESS_ENABLED__) return;
  window.__JASMINE_CONTEXT_TAXONOMY_RENDERS__ = (window.__JASMINE_CONTEXT_TAXONOMY_RENDERS__ ?? 0) + 1;
}

declare global {
  interface Window {
    __JASMINE_CONTEXT_TAXONOMY_RENDERS__?: number;
  }
}

function TaxonomyHeader(props: {
  taxonomy: ContextTaxonomy;
  captures?: CaptureOption[];
  captureId: string;
  onSelectCapture?(captureId: string): void;
}) {
  const { language, t } = useI18n();
  const taxonomy = props.taxonomy;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const captures = props.captures ?? [];
  const approximate = taxonomy.source === "jasmine-assembly";

  const copyHash = async () => {
    if (!taxonomy.payloadHash) return;
    setCopyError(null);
    try {
      await getBridge().writeClipboardText(taxonomy.payloadHash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (cause) {
      setCopied(false);
      setCopyError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <header className="taxonomy-head">
      <div className="taxonomy-head-id">
        <strong title={`${taxonomy.provider}/${taxonomy.model}`}>{taxonomy.provider}/{taxonomy.model}</strong>
        {approximate && <span className="taxonomy-head-approximate">approximate</span>}
        {captures.length > 1 && props.onSelectCapture && (
          <div className="taxonomy-request-switcher" role="group" aria-label={t("taxonomy.providerRequest")}>
            {captures.map((capture) => (
              <button
                key={capture.id}
                type="button"
                aria-pressed={capture.id === props.captureId}
                aria-label={t("taxonomy.requestPosition", { index: capture.requestIndex, count: capture.requestCount })}
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
        <span>{formatCapturedAt(taxonomy.capturedAt, language)}</span>
        {taxonomy.payloadHash && (
          <>
            <span className="taxonomy-head-dot">·</span>
            <button
              type="button"
              className="taxonomy-head-hash"
              title={copyError ?? t("taxonomy.copyHash")}
              aria-live="polite"
              onClick={() => void copyHash()}
            >
              {copied ? t("taxonomy.copied") : copyError ? t("taxonomy.copyFailed") : taxonomy.payloadHash.slice(0, 12)}
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
  const { language, t } = useI18n();
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
    <section className="taxonomy-budget" aria-label={t("taxonomy.budgetAria")}>
      <div className="taxonomy-total">
        <b className="taxonomy-total-value">{primary.toLocaleString(localeTag(language))}</b>
        <span className="taxonomy-total-label">{actualInput === undefined ? "estimated input tokens" : "actual input tokens"}</span>
        {actualInput !== undefined && (
          <em className="taxonomy-total-estimate">
            est. {props.estimatedTotal.toLocaleString(localeTag(language))}
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
          <ul className="taxonomy-legend" aria-label={t("taxonomy.compositionAria")}>
            {props.composition.map((entry) => (
              <li key={entry.bucket}>
                <button
                  type="button"
                  aria-pressed={props.bucketFilter === entry.bucket}
                  onClick={() => props.onBucketFilter(props.bucketFilter === entry.bucket ? null : entry.bucket)}
                >
                  <i style={{ background: bucketColor(entry.bucket) }} aria-hidden="true" />
                  <span className="taxonomy-legend-label">{entry.label}</span>
                  <span className="taxonomy-legend-value">{entry.tokens.toLocaleString(localeTag(language))}</span>
                  <span className="taxonomy-legend-percent">{Math.round(entry.percent)}%</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="taxonomy-status">
        {taxonomy.source === "jasmine-assembly" && (
          <button {...chipProps("assembly")} data-tone="bad">{t("taxonomy.reconstructedChip")}</button>
        )}
        {metrics && (
          <button {...chipProps("cache")} data-tone={metrics.cacheHitTokens > 0 ? "ok" : "neutral"}>
            {t("taxonomy.cacheChip", { rate: Math.round(metrics.hitRate * 1000) / 10 })}
          </button>
        )}
        {validation && (
          <button {...chipProps("reasoning")} data-tone={validationTone(validation.status)}>
            {t("taxonomy.reasoningChip", { status: validationStatusLabel(validation.status, t) })}
          </button>
        )}
        {props.unclassifiedPaths.length > 0 && (
          <button {...chipProps("unclassified")} data-tone="bad">
            {t(props.unclassifiedPaths.length === 1 ? "taxonomy.unknownField" : "taxonomy.unknownFields", { count: props.unclassifiedPaths.length })}
          </button>
        )}
      </div>

      {openChips.has("assembly") && (
        <div className="taxonomy-status-detail" aria-label={t("taxonomy.reconstructedWarning")}>
          <strong>The exact provider payload was unavailable</strong>
          <span>This taxonomy was reassembled from what Jasmine sent, so some context parts may be missing.</span>
          {taxonomy.assemblyReason && <code>reason: {taxonomy.assemblyReason}</code>}
        </div>
      )}
      {openChips.has("cache") && metrics && (
        <div className="taxonomy-status-detail" aria-label={t("taxonomy.cacheEvidence")}>
          <div className="taxonomy-kv"><span>Cache hit</span><b>{metrics.cacheHitTokens.toLocaleString(localeTag(language))}</b></div>
          <div className="taxonomy-kv"><span>Cache miss</span><b>{metrics.cacheMissTokens.toLocaleString(localeTag(language))}</b></div>
          <div className="taxonomy-kv"><span>Cache write</span><b>{metrics.cacheWriteTokens.toLocaleString(localeTag(language))}</b></div>
          <div className="taxonomy-kv"><span>Output</span><b>{metrics.outputTokens.toLocaleString(localeTag(language))}</b></div>
          <span>{metrics.note}</span>
        </div>
      )}
      {openChips.has("reasoning") && validation && (
        <div className="taxonomy-status-detail" aria-label={t("taxonomy.reasoningValidation")}>
          <strong>{policyLabel(validation.policyId)}</strong>
          <span>{validation.summary}</span>
          {validation.requiredCount > 0 && (
            <div className="taxonomy-kv"><span>Required blocks present</span><b>{validation.sentCount}/{validation.requiredCount}</b></div>
          )}
          {validation.policySource && <a href={validation.policySource} target="_blank" rel="noreferrer">{t("taxonomy.providerPolicy")}</a>}
        </div>
      )}
      {openChips.has("unclassified") && (
        <div className="taxonomy-status-detail" aria-label={t("taxonomy.unclassifiedWarning")}>
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
  const { language } = useI18n();
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
        <span className="taxonomy-item-tokens">{resolved.tokenEstimate.toLocaleString(localeTag(language))}</span>
      </summary>
      {props.open && (
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
              : resolved.foldedCount > 0
                ? null
                : <RenderedBody
                    text={resolved.item.text ?? resolved.item.preview}
                    format={looksLikeJson(resolved.item.text ?? "") ? "json" : "markdown"}
                    title={resolved.title}
                  />}
        </div>
      )}
    </details>
  );
}

function TaxonomyPartView(props: { part: ResolvedPart; open: boolean; onToggle(open: boolean): void }) {
  const { language } = useI18n();
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
        <span className="taxonomy-part-tokens">{part.tokenEstimate.toLocaleString(localeTag(language))}</span>
      </summary>
      {props.open && (
        <div className="taxonomy-part-body">
          {(part.payloadPath || part.toolCallId) && (
            <div className="taxonomy-part-meta">
              {part.toolCallId && <span>{part.toolCallId}</span>}
              {part.payloadPath && <PayloadPath path={part.payloadPath} />}
            </div>
          )}
          <RenderedBody text={part.text} format={part.format} title={part.title} />
        </div>
      )}
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
  const { language, t } = useI18n();
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
          <strong>{t("taxonomy.rawPayload")}</strong>
          <small>
            {t("taxonomy.rawSummary", {
              state: rawStateLabel(props.taxonomy.rawState, t),
              bytes: (props.taxonomy.rawByteCount ?? 0).toLocaleString(localeTag(language))
            })}
            {shape && shape.topLevelOrder.length > 0 ? ` · ${shape.topLevelOrder.join(" → ")}` : ""}
          </small>
        </span>
        <Button
          size="sm"
          variant="quiet"
          disabled={props.taxonomy.rawState === "unavailable" || loading}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); void copyFull(); }}
        >
          {copied ? t("taxonomy.copied") : t("taxonomy.copyFull")}
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
        {text && <ShikiCodeBlock code={text} language="json" kind="json" title={t("taxonomy.sanitizedPayload")} />}
        {!done && props.taxonomy.rawState !== "unavailable" && (
          <Button className="taxonomy-load-more" size="sm" variant="quiet" loading={loading} onClick={() => void loadMore()}>
            {loading ? t("taxonomy.loading") : t("taxonomy.loadNext")}
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

const GROUP_ORDER: Array<{ id: "instructions" | "conversation" | "prompt" | "tools" | "options" | "unknown"; kinds: ContextTaxonomyKind[] }> = [
  { id: "instructions", kinds: ["system_prompt", "developer_instructions", "project_context", "skill_manifest", "skill_instructions", "prompt_template", "memory"] },
  { id: "conversation", kinds: ["conversation_history", "provider_message", "attachment"] },
  { id: "prompt", kinds: ["current_user_prompt"] },
  { id: "tools", kinds: ["tool_definition"] },
  { id: "options", kinds: ["provider_options"] },
  { id: "unknown", kinds: ["unclassified", "unknown", "raw_payload"] }
];

/** Kinds whose parts describe message content rather than a payload section. */
const MESSAGE_KINDS = new Set<ContextTaxonomyKind>([
  "system_prompt", "developer_instructions", "conversation_history", "current_user_prompt", "attachment", "provider_message"
]);

export function buildGroups(taxonomy: ContextTaxonomy, t: ReturnType<typeof useI18n>["t"] = translate("en")): ResolvedGroup[] {
  const resolved = taxonomy.items.map((item) => resolveItem(item, t));
  return GROUP_ORDER.map((group) => {
    const items = resolved.filter((entry) => group.kinds.includes(entry.item.kind ?? fallbackKind(entry.item.role)));
    return {
      id: group.id,
      label: t(`taxonomy.group.${group.id}`),
      items,
      tokenEstimate: items.reduce((total, entry) => total + entry.tokenEstimate, 0)
    };
  }).filter((group) => group.items.length > 0);
}

function resolveItem(item: ContextTaxonomyItem, t: ReturnType<typeof useI18n>["t"]): ResolvedItem {
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
    // The classifier creates segments from `item.text`, and provider-message
    // extraction builds that text from every wire part. Semantic segments
    // replace only the message's `text` part; metadata and every classified
    // non-text sibling still need their exact wire row. Reserve all of those
    // tokens before rendering the segments so preserving the rows does not
    // inflate either the item total or the composition.
    const preservedWireTokens = parts
      .filter((part) => part.kind !== "text")
      .reduce((total, part) => total + part.tokenEstimate, 0);
    const segmentTokens = allocateTokenBudget(
      segments.map((segment) => segment.tokenEstimate),
      Math.max(0, item.tokenEstimate - preservedWireTokens)
    );
    for (const [index, segment] of segments.entries()) {
      resolvedParts.push({
        key: `${key}:s${index}`,
        bucket: bucketForKind(segment.kind),
        tag: segment.kind,
        title: segment.title,
        text: segment.text,
        format: looksLikeJson(segment.text) ? "json" : "markdown",
        tokenEstimate: segmentTokens[index] ?? 0,
        isReasoning: false
      });
    }
    // The segments re-split this message's own text, so its `text` part is
    // already on screen. Every non-text sibling remains a distinct provider
    // field whose kind and exact path would otherwise disappear from the tree.
    for (const part of parts) {
      if (part.kind === "metadata") {
        foldedTokens += part.tokenEstimate;
        foldedCount += 1;
      } else if (part.kind !== "text") {
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

  const itemBucket = bucketForKind(kind);
  const only = resolvedParts.length === 1 ? resolvedParts[0] : null;
  const single = only && only.bucket === itemBucket && !only.toolName && !only.toolCallId ? only : null;

  const meta: string[] = [item.role];
  if (foldedCount > 0) meta.push(`+${foldedCount} envelope ${foldedCount === 1 ? "field" : "fields"}`);
  const path = single?.payloadPath ?? item.payloadPath ?? item.source;

  const buckets = new Set(attributedBucketTokens(itemBucket, resolvedParts, tokenEstimate, foldedCount > 0).keys());
  const title = itemTitle(item, kind, t);

  return {
    key,
    item,
    title,
    bucket: itemBucket,
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

function allocateTokenBudget(weights: number[], budget: number): number[] {
  if (weights.length === 0) return [];
  const normalizedBudget = Math.max(0, Math.round(budget));
  const totalWeight = weights.reduce((total, weight) => total + Math.max(0, weight), 0);
  if (totalWeight === 0) return weights.map((_weight, index) => index === 0 ? normalizedBudget : 0);

  const exact = weights.map((weight) => Math.max(0, weight) / totalWeight * normalizedBudget);
  const allocated = exact.map((value) => Math.floor(value));
  let remainder = normalizedBudget - allocated.reduce((total, value) => total + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - allocated[index] }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < byRemainder.length && remainder > 0; index += 1, remainder -= 1) {
    allocated[byRemainder[index].index] += 1;
  }
  return allocated;
}

function attributedBucketTokens(
  itemBucket: ContextBucket,
  parts: ResolvedPart[],
  tokenEstimate: number,
  hasFoldedMetadata: boolean
): Map<ContextBucket, number> {
  const values = new Map<ContextBucket, number>();
  const add = (bucket: ContextBucket, tokens: number) => {
    if (tokens <= 0) return;
    values.set(bucket, (values.get(bucket) ?? 0) + tokens);
  };

  if (parts.length === 0) {
    add(hasFoldedMetadata ? "options" : itemBucket, tokenEstimate);
    return values;
  }

  const partTokens = parts.reduce((total, part) => total + part.tokenEstimate, 0);
  for (const part of parts) add(part.bucket, part.tokenEstimate);
  // Envelope fields are folded out of the tree but still sent to the provider.
  if (tokenEstimate > partTokens) add(hasFoldedMetadata ? "options" : itemBucket, tokenEstimate - partTokens);
  return values;
}

export function buildComposition(
  groups: ResolvedGroup[],
  total: number,
  t: ReturnType<typeof useI18n>["t"] = translate("en")
): CompositionItem[] {
  const values = new Map<ContextBucket, number>();
  const add = (bucket: ContextBucket, tokens: number) => values.set(bucket, (values.get(bucket) ?? 0) + tokens);

  for (const group of groups) {
    for (const resolved of group.items) {
      for (const [bucket, tokens] of attributedBucketTokens(
        resolved.bucket,
        resolved.parts,
        resolved.tokenEstimate,
        resolved.foldedCount > 0
      )) {
        add(bucket, tokens);
      }
    }
  }

  return Array.from(values.entries())
    .filter(([, tokens]) => tokens > 0)
    .map(([bucket, tokens]) => ({ bucket, label: bucketLabel(bucket, t), tokens, percent: total ? tokens / total * 100 : 0 }))
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

function itemTitle(item: ContextTaxonomyItem, kind: ContextTaxonomyKind, t: ReturnType<typeof useI18n>["t"]): string {
  if (kind === "tool_definition") return item.label.replace(/^Tool definitions?:?\s*/i, "");
  if (kind === "provider_options") return t("taxonomy.item.requestOptions");
  if (kind === "unclassified" && item.role === "unclassified" && item.payloadPath === "$") return t("taxonomy.item.otherPayloadFields");
  if (kind === "current_user_prompt") return t("taxonomy.item.currentUserPrompt");
  if (kind === "system_prompt") return t("taxonomy.item.systemPrompt");
  if (kind === "developer_instructions") return t("taxonomy.item.developerInstructions");
  if (kind === "conversation_history" || kind === "provider_message") return t("taxonomy.item.turn", { role: roleLabel(item.role, t) });
  return item.label || item.role;
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

function roleLabel(role: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (role === "user" || role === "assistant" || role === "tool" || role === "system" || role === "developer") {
    return t(`taxonomy.role.${role}`);
  }
  return role;
}

function bucketLabel(bucket: ContextBucket, t: ReturnType<typeof useI18n>["t"]): string {
  if (bucket === "tool_call") return t("taxonomy.bucket.toolCall");
  if (bucket === "tool_definition") return t("taxonomy.bucket.toolDefinition");
  if (bucket === "tool_result") return t("taxonomy.bucket.toolResult");
  return t(`taxonomy.bucket.${bucket}`);
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

function formatCapturedAt(value: string, language: AppLanguage): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString(localeTag(language), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function validationStatusLabel(status: ContextReasoningValidation["status"], t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "pass") return t("taxonomy.validation.kept");
  if (status === "fail") return t("taxonomy.validation.dropped");
  if (status === "not_applicable") return t("taxonomy.validation.notApplicable");
  return t("taxonomy.validation.unknown");
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

function rawStateLabel(state: ContextTaxonomy["rawState"], t: ReturnType<typeof useI18n>["t"]): string {
  if (state === "legacy_truncated") return t("taxonomy.rawState.truncated");
  if (state === "unavailable") return t("taxonomy.rawState.unavailable");
  return t("taxonomy.rawState.complete");
}
