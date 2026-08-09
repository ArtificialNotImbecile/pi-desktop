import { useMemo, useState, type SyntheticEvent } from "react";
import type { ContextReasoningValidation, ContextTaxonomy, ContextTaxonomyItem, ContextTaxonomyKind, ContextTaxonomyPart, ContextTaxonomySegment } from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";
import { looksLikeJson, ShikiCodeBlock } from "../code";
import { Button } from "../ui";
import { MarkdownMessage } from "./MarkdownMessage";

type CompositionItem = { kind: string; label: string; tokens: number; percent: number; color: string };

export function TaxonomyView(props: { taxonomy: ContextTaxonomy; captureId: string }) {
  const estimatedTotal = useMemo(() => taxonomyEstimatedTokens(props.taxonomy), [props.taxonomy]);
  const composition = useMemo(() => buildComposition(props.taxonomy), [props.taxonomy]);
  const unclassifiedPaths = useMemo(() => collectUnclassifiedPaths(props.taxonomy), [props.taxonomy]);
  const actualInput = props.taxonomy.cacheMetrics?.inputTokens;
  const request = props.taxonomy.providerRequest;

  return (
    <div className="taxonomy-view">
      <header className="taxonomy-summary">
        <div className="taxonomy-summary-main">
          <strong>{props.taxonomy.provider}/{props.taxonomy.model}</strong>
          <span>
            {props.taxonomy.source} / schema v{props.taxonomy.payloadSchemaVersion ?? 1}
            {request ? ` / request ${request.index} of ${request.count}` : ""}
          </span>
        </div>
        <div className="taxonomy-summary-counts" aria-label="Context token evidence">
          {actualInput !== undefined && <span>{actualInput.toLocaleString()} actual input tokens</span>}
          <span>~{estimatedTotal.toLocaleString()} estimated by part</span>
          <span>{props.taxonomy.items.length} wire items</span>
        </div>
        {props.taxonomy.payloadHash && (
          <span className="taxonomy-summary-hash">full sanitized payload sha256 {props.taxonomy.payloadHash.slice(0, 12)}</span>
        )}
      </header>

      {props.taxonomy.source === "jasmine-assembly" && <AssemblyWarning taxonomy={props.taxonomy} />}
      {unclassifiedPaths.length > 0 && <UnclassifiedWarning paths={unclassifiedPaths} />}
      {props.taxonomy.reasoningValidation && <ReasoningValidationCard validation={props.taxonomy.reasoningValidation} />}
      {props.taxonomy.cacheMetrics && <CacheMetrics taxonomy={props.taxonomy} />}
      {composition.length > 0 && <Composition items={composition} estimatedTotal={estimatedTotal} />}
      {props.taxonomy.payloadShape && <PayloadShape taxonomy={props.taxonomy} />}

      <p className="taxonomy-derived-note">
        Items follow provider wire order. Text, reasoning, tool calls, and tool results are shown once as separate parts; per-part tokens are estimates.
      </p>
      <div className="taxonomy-items" aria-label="Derived context taxonomy">
        {props.taxonomy.items.map((item) => <TaxonomyItemView key={`${item.order}-${item.payloadPath ?? item.source}`} item={item} validation={props.taxonomy.reasoningValidation} />)}
      </div>

      <RawPayload captureId={props.captureId} taxonomy={props.taxonomy} />
    </div>
  );
}

function UnclassifiedWarning(props: { paths: string[] }) {
  return (
    <section className="taxonomy-unclassified-card" aria-label="Unclassified provider payload warning">
      <strong>{props.paths.length} unclassified payload {props.paths.length === 1 ? "field" : "fields"}</strong>
      <span>Retained in provider wire order. Add a classifier rule if these fields carry model context.</span>
      <code>{props.paths.slice(0, 4).join(" · ")}{props.paths.length > 4 ? ` · +${props.paths.length - 4} more` : ""}</code>
    </section>
  );
}

function AssemblyWarning(props: { taxonomy: ContextTaxonomy }) {
  return (
    <section className="taxonomy-warning-card" aria-label="Reconstructed context taxonomy warning">
      <strong>Reconstructed approximation</strong>
      <span>The exact provider payload was unavailable. Some context parts may be missing.</span>
      {props.taxonomy.assemblyReason && <code>reason: {props.taxonomy.assemblyReason}</code>}
    </section>
  );
}

function ReasoningValidationCard(props: { validation: ContextReasoningValidation }) {
  const validation = props.validation;
  return (
    <section className={`taxonomy-validation-card taxonomy-validation-${validation.status}`} aria-label="Reasoning retention validation">
      <div>
        <strong>Reasoning retention: {validationStatusLabel(validation.status)}</strong>
        <span>{policyLabel(validation.policyId)}</span>
      </div>
      <p>{validation.summary}</p>
      {validation.requiredCount > 0 && <small>{validation.sentCount}/{validation.requiredCount} required blocks present</small>}
      {validation.policySource && <a href={validation.policySource} target="_blank" rel="noreferrer">Provider policy</a>}
    </section>
  );
}

function CacheMetrics(props: { taxonomy: ContextTaxonomy }) {
  const metrics = props.taxonomy.cacheMetrics!;
  return (
    <section className={`taxonomy-cache-card taxonomy-cache-card-${metrics.status}`} aria-label="Provider cache evidence">
      <div className="taxonomy-cache-heading">
        <strong>Provider usage</strong>
        <span>{Math.round(metrics.hitRate * 1000) / 10}% cache hit</span>
      </div>
      <div className="taxonomy-cache-meter" aria-label={`Cache hit rate ${Math.round(metrics.hitRate * 100)} percent`}>
        <span style={{ width: `${Math.max(0, Math.min(100, metrics.hitRate * 100))}%` }} />
      </div>
      <div className="taxonomy-cache-stats">
        <span>{metrics.inputTokens.toLocaleString()} input</span>
        <span>{metrics.cacheHitTokens.toLocaleString()} hit</span>
        <span>{metrics.cacheMissTokens.toLocaleString()} miss</span>
        <span>{metrics.outputTokens.toLocaleString()} output</span>
      </div>
    </section>
  );
}

function Composition(props: { items: CompositionItem[]; estimatedTotal: number }) {
  return (
    <section className="taxonomy-composition" aria-label="Estimated context composition">
      <div className="taxonomy-composition-heading">
        <strong>Estimated composition</strong>
        <span>~{props.estimatedTotal.toLocaleString()} tokens</span>
      </div>
      <div className="taxonomy-composition-bar" aria-hidden="true">
        {props.items.map((item) => <span key={item.kind} style={{ width: `${Math.max(2, item.percent)}%`, background: item.color }} />)}
      </div>
      <div className="taxonomy-composition-list">
        {props.items.map((item) => (
          <span key={item.kind}><i style={{ background: item.color }} aria-hidden="true" />{item.label} ~{item.tokens.toLocaleString()} ({Math.round(item.percent)}%)</span>
        ))}
      </div>
    </section>
  );
}

function PayloadShape(props: { taxonomy: ContextTaxonomy }) {
  const shape = props.taxonomy.payloadShape!;
  if (shape.topLevelOrder.length === 0) return null;
  return (
    <details className="taxonomy-payload-shape">
      <summary><strong>Payload shape</strong><span>{shape.messageCount ?? 0} messages / {shape.toolCount ?? 0} tools</span></summary>
      <div className="taxonomy-payload-order">
        {shape.topLevelOrder.map((key, index) => <span key={`${key}-${index}`}>{index > 0 && <i aria-hidden="true">→</i>}<code>{key}</code></span>)}
      </div>
    </details>
  );
}

function TaxonomyItemView(props: { item: ContextTaxonomyItem; validation?: ContextReasoningValidation }) {
  const item = props.item;
  const parts = item.parts ?? [];
  const segments = item.segments ?? [];
  const useInstructionSegments = (item.role === "system" || item.role === "developer") && segments.length > 1;
  const initiallyOpen = item.kind === "current_user_prompt" || item.kind === "tool_definition" || item.kind === "unclassified";
  const [expanded, setExpanded] = useState(initiallyOpen);
  const unclassifiedParts = parts.filter((part) => part.kind === "unclassified");
  return (
    <article className="taxonomy-item">
      <details className="taxonomy-item-details" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>
          <b title="Wire presentation order">{item.order}</b>
          <span className="taxonomy-item-title"><strong>{itemTitle(item)}</strong><small>{item.role} · {item.payloadPath ?? item.source}</small></span>
          {item.kind && <span className="taxonomy-kind-pill">{kindLabel(item.kind)}</span>}
        </summary>
        <div className="taxonomy-item-meta">
          <span>{item.label}</span><span>~{item.tokenEstimate.toLocaleString()} estimated tokens</span>
        </div>
        {useInstructionSegments
          ? <><LegacySegments segments={segments} openByDefault={expanded} />{unclassifiedParts.length > 0 && <div className="taxonomy-parts">{unclassifiedParts.map((part) => <TaxonomyPartView key={`${part.order}-${part.payloadPath ?? part.title}`} part={part} validation={props.validation} openByDefault={expanded} />)}</div>}</>
          : parts.length > 0
            ? <div className="taxonomy-parts">{parts.map((part) => <TaxonomyPartView key={`${part.order}-${part.payloadPath ?? part.title}`} part={part} validation={props.validation} openByDefault={expanded} />)}</div>
            : segments.length > 0
              ? <LegacySegments segments={segments} openByDefault={expanded} />
              : <RenderedBody text={item.text ?? item.preview} format={looksLikeJson(item.text ?? "") ? "json" : "markdown"} title={item.label} />}
      </details>
    </article>
  );
}

function TaxonomyPartView(props: { part: ContextTaxonomyPart; validation?: ContextReasoningValidation; openByDefault?: boolean }) {
  const part = props.part;
  const failedReasoning = part.kind === "reasoning" && props.validation?.status === "fail";
  return (
    <details className={`taxonomy-part taxonomy-part-${part.kind}`} open={props.openByDefault || failedReasoning || part.kind === "tool_call" || part.kind === "tool_result" || part.kind === "unclassified"}>
      <summary>
        <span>{part.title}</span>
        <small>
          {part.toolName ? `${part.toolName} · ` : ""}{part.toolCallId ? `${part.toolCallId} · ` : ""}~{part.tokenEstimate.toLocaleString()} tokens
        </small>
      </summary>
      <RenderedBody text={part.text} format={part.format} title={part.title} />
    </details>
  );
}

function LegacySegments(props: { segments: ContextTaxonomySegment[]; openByDefault?: boolean }) {
  return (
    <div className="taxonomy-parts">
      {props.segments.map((segment, index) => (
        <details key={`${segment.kind}-${index}`} className="taxonomy-part" open={props.openByDefault || segment.kind === "current_user_prompt"}>
          <summary><span>{segment.title}</span><small>~{segment.tokenEstimate.toLocaleString()} tokens</small></summary>
          <RenderedBody text={segment.text} format={looksLikeJson(segment.text) ? "json" : "markdown"} title={segment.title} />
        </details>
      ))}
    </div>
  );
}

function RenderedBody(props: { text: string; format: "text" | "markdown" | "json"; title: string }) {
  if (props.format === "json") return <ShikiCodeBlock code={props.text} language="json" kind="json" title={props.title} />;
  return <MarkdownMessage content={props.text} onCopyCode={(text) => { void getBridge().writeClipboardText(text); }} />;
}

function RawPayload(props: { captureId: string; taxonomy: ContextTaxonomy }) {
  const [text, setText] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
      <summary>
        <span><strong>Sanitized raw provider payload</strong><small>{rawStateLabel(props.taxonomy.rawState)} · {(props.taxonomy.rawByteCount ?? 0).toLocaleString()} bytes gzip-backed</small></span>
        <Button size="sm" variant="quiet" disabled={props.taxonomy.rawState === "unavailable" || loading} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void copyFull(); }}>{copied ? "Copied" : "Copy full"}</Button>
      </summary>
      {error && <p className="taxonomy-raw-error">{error}</p>}
      {text && <ShikiCodeBlock code={text} language="json" kind="json" title="sanitized provider payload" />}
      {!done && props.taxonomy.rawState !== "unavailable" && <Button className="taxonomy-load-more" size="sm" variant="quiet" loading={loading} onClick={() => void loadMore()}>{loading ? "Loading…" : "Load next 64 KiB"}</Button>}
      {props.taxonomy.rawState === "unavailable" && <p className="taxonomy-raw-error">Raw payload was not available for this legacy or reconstructed capture.</p>}
    </details>
  );
}

function taxonomyEstimatedTokens(taxonomy: ContextTaxonomy): number {
  return taxonomy.items.reduce((total, item) => {
    const useInstructionSegments = (item.role === "system" || item.role === "developer") && (item.segments?.length ?? 0) > 1;
    return total + (item.parts?.length && !useInstructionSegments
    ? item.parts.reduce((sum, part) => sum + part.tokenEstimate, 0)
    : item.segments?.length
      ? item.segments.reduce((sum, segment) => sum + segment.tokenEstimate, 0)
      : item.tokenEstimate);
  }, 0);
}

function collectUnclassifiedPaths(taxonomy: ContextTaxonomy): string[] {
  const paths = new Set<string>();
  for (const item of taxonomy.items) {
    if (item.kind === "unclassified") paths.add(item.payloadPath ?? item.source);
    for (const part of item.parts ?? []) {
      if (part.kind === "unclassified") paths.add(part.payloadPath ?? `${item.payloadPath ?? item.source}:${part.order}`);
    }
  }
  return Array.from(paths);
}

function buildComposition(taxonomy: ContextTaxonomy): CompositionItem[] {
  const values = new Map<string, number>();
  for (const item of taxonomy.items) {
    const useInstructionSegments = (item.role === "system" || item.role === "developer") && (item.segments?.length ?? 0) > 1;
    if (item.parts?.length && !useInstructionSegments) {
      for (const part of item.parts) values.set(part.kind, (values.get(part.kind) ?? 0) + part.tokenEstimate);
    } else if (item.segments?.length) {
      for (const segment of item.segments) values.set(segment.kind, (values.get(segment.kind) ?? 0) + segment.tokenEstimate);
    } else {
      const kind = item.kind ?? "unknown";
      values.set(kind, (values.get(kind) ?? 0) + item.tokenEstimate);
    }
  }
  const total = Array.from(values.values()).reduce((sum, value) => sum + value, 0);
  return Array.from(values.entries()).map(([kind, tokens]) => ({
    kind, label: partOrKindLabel(kind), tokens, percent: total ? tokens / total * 100 : 0, color: compositionColor(kind)
  })).sort((left, right) => right.tokens - left.tokens);
}

function itemTitle(item: ContextTaxonomyItem): string {
  if (item.kind === "tool_definition") return item.label.replace(/^Tool definition:?\s*/i, "Tool: ");
  if (item.kind === "provider_options") return "Request options";
  if (item.kind === "current_user_prompt") return "Current user prompt";
  if (item.kind === "conversation_history") return "Conversation history";
  if (item.kind === "system_prompt") return "System prompt";
  return item.label || item.role;
}

function kindLabel(kind: ContextTaxonomyKind): string {
  const labels: Record<ContextTaxonomyKind, string> = {
    system_prompt: "System", developer_instructions: "Developer", project_context: "Project", skill_manifest: "Skills",
    skill_instructions: "Skill instructions", prompt_template: "Template", memory: "Memory", conversation_history: "History",
    current_user_prompt: "Current prompt", tool_definition: "Tool", provider_options: "Options", attachment: "Attachment",
    provider_message: "Provider message", raw_payload: "Raw", unclassified: "Unclassified", unknown: "Unknown"
  };
  return labels[kind];
}

function partOrKindLabel(kind: string): string {
  const labels: Record<string, string> = { text: "Text", reasoning: "Reasoning", tool_call: "Tool calls", tool_result: "Tool results", attachment: "Attachments", refusal: "Refusal", metadata: "Metadata", unclassified: "Unclassified" };
  return labels[kind] ?? kindLabel(kind as ContextTaxonomyKind) ?? kind;
}

function compositionColor(kind: string): string {
  if (kind === "reasoning") return "var(--accent)";
  if (kind === "tool_call" || kind === "tool_definition") return "color-mix(in srgb, var(--accent) 68%, var(--danger))";
  if (kind === "tool_result") return "var(--success)";
  if (kind === "current_user_prompt") return "var(--accent)";
  if (kind === "attachment") return "var(--danger)";
  if (kind === "unclassified") return "color-mix(in srgb, var(--danger) 55%, var(--accent))";
  return "var(--muted)";
}

function validationStatusLabel(status: ContextReasoningValidation["status"]): string {
  return ({ pass: "Pass", fail: "Missing required context", not_applicable: "Not required", unknown: "Unknown" } as const)[status];
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
  if (state === "legacy_truncated") return "Legacy truncated raw";
  if (state === "unavailable") return "Raw unavailable";
  return "Complete raw";
}
