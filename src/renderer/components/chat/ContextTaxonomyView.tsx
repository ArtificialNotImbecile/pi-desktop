import { useMemo } from "react";
import type { ContextTaxonomy, ContextTaxonomyKind, ContextTaxonomySegment } from "../../../shared/ipc";
import { looksLikeJson, ShikiCodeBlock } from "../code";

type TaxonomySegmentViewModel = ContextTaxonomySegment;

type KindBreakdownItem = {
  kind: ContextTaxonomyKind;
  label: string;
  tokens: number;
  percent: number;
  color: string;
};

type TaxonomyGroup = {
  key: string;
  label: string;
  items: ContextTaxonomy["items"];
  tokens: number;
};

export function TaxonomyView(props: { taxonomy: ContextTaxonomy }) {
  const total = useMemo(() => props.taxonomy.items.reduce((sum, item) => sum + item.tokenEstimate, 0), [props.taxonomy]);
  const counts = useMemo(() => ({
    messages: props.taxonomy.items.filter((item) => item.source === "provider.payload.messages" || item.source === "session.history" || item.source === "current.prompt" || item.source === "jasmine.systemPrompt").length,
    tools: props.taxonomy.items.filter((item) => item.kind === "tool_definition" || item.source === "provider.payload.tools").length,
    options: props.taxonomy.items.filter((item) => item.kind === "provider_options" || item.source === "provider.payload.options").length,
    segments: props.taxonomy.items.reduce((sum, item) => sum + (item.segments?.length ?? 0), 0)
  }), [props.taxonomy]);
  const kindBreakdown = useMemo(() => buildKindBreakdown(props.taxonomy), [props.taxonomy]);
  const groups = useMemo(() => groupTaxonomyItems(props.taxonomy.items), [props.taxonomy.items]);

  return (
    <div className="taxonomy-view">
      <div className="taxonomy-summary">
        <div className="taxonomy-summary-main">
          <strong>{props.taxonomy.provider}/{props.taxonomy.model}</strong>
          <span>{props.taxonomy.source} / schema v{props.taxonomy.payloadSchemaVersion ?? 1} / ~{total.toLocaleString()} tokens</span>
        </div>
        {props.taxonomy.payloadHash && <span className="taxonomy-summary-hash">payload sha256 {props.taxonomy.payloadHash.slice(0, 12)}</span>}
        <div className="taxonomy-summary-counts" aria-label="Provider payload counts">
          <span>{counts.messages} messages</span>
          <span>{counts.tools} tools</span>
          <span>{counts.options} options</span>
          <span>{counts.segments} pieces</span>
        </div>
      </div>
      {props.taxonomy.source === "jasmine-assembly" && <TaxonomyAssemblyWarning taxonomy={props.taxonomy} />}
      {props.taxonomy.providerRequest && <TaxonomyProviderRequestNote taxonomy={props.taxonomy} />}
      {props.taxonomy.cacheMetrics && <TaxonomyCacheMetrics taxonomy={props.taxonomy} />}
      {props.taxonomy.payloadShape && <TaxonomyPayloadShape taxonomy={props.taxonomy} />}
      {kindBreakdown.length > 0 && <TaxonomyComposition items={kindBreakdown} total={total} />}
      {props.taxonomy.rawPayload && (
        <details className="taxonomy-raw-payload">
          <summary>
            <strong>Raw provider payload</strong>
            <span>captured at Pi before_provider_request</span>
          </summary>
          <ShikiCodeBlock code={props.taxonomy.rawPayload} language="json" kind="json" title="provider payload" />
        </details>
      )}
      <p className="taxonomy-derived-note">Derived rows below are generated from the captured payload for reading. Numbering is presentation order; raw array positions are shown through each payload path.</p>
      <div className="taxonomy-items" aria-label="Derived context taxonomy">
        {groups.map((group) => (
          <TaxonomyKindGroup key={group.key} group={group} />
        ))}
      </div>
    </div>
  );
}

function TaxonomyAssemblyWarning(props: { taxonomy: ContextTaxonomy }) {
  return (
    <section className="taxonomy-warning-card" aria-label="Reconstructed context taxonomy warning">
      <strong>Reconstructed approximation</strong>
      <span>Not the exact Pi provider payload. Tool definitions, project context, skills, prompt templates, and provider options may be missing.</span>
      {props.taxonomy.assemblyReason && <code>reason: {assemblyReasonLabel(props.taxonomy.assemblyReason)}</code>}
    </section>
  );
}

function TaxonomyProviderRequestNote(props: { taxonomy: ContextTaxonomy }) {
  const request = props.taxonomy.providerRequest;
  if (!request) return null;
  const text = request.count > 1
    ? `Showing provider request ${request.index} of ${request.count}: the latest capture for this assistant turn.`
    : "Showing the single provider request captured for this assistant turn.";
  return <p className="taxonomy-provider-request-note">{text}</p>;
}

function TaxonomyCacheMetrics(props: { taxonomy: ContextTaxonomy }) {
  const metrics = props.taxonomy.cacheMetrics;
  if (!metrics) return null;
  return (
    <section className={`taxonomy-cache-card taxonomy-cache-card-${metrics.status}`} aria-label="Provider cache evidence">
      <div className="taxonomy-cache-heading">
        <strong>Cache evidence</strong>
        <span>{Math.round(metrics.hitRate * 1000) / 10}% hit from provider usage</span>
      </div>
      <div className="taxonomy-cache-meter" aria-label={`Cache hit rate ${Math.round(metrics.hitRate * 100)} percent`}>
        <span style={{ width: `${Math.max(0, Math.min(100, metrics.hitRate * 100))}%` }} />
      </div>
      <div className="taxonomy-cache-stats">
        <span>{metrics.cacheHitTokens.toLocaleString()} hit</span>
        <span>{metrics.cacheMissTokens.toLocaleString()} miss</span>
        {metrics.cacheWriteTokens > 0 && <span>{metrics.cacheWriteTokens.toLocaleString()} write</span>}
        <span>{metrics.inputTokens.toLocaleString()} input</span>
      </div>
      <p>{metrics.note} This is evidence from the provider response, not inferred from JSON key order.</p>
    </section>
  );
}

function TaxonomyPayloadShape(props: { taxonomy: ContextTaxonomy }) {
  const shape = props.taxonomy.payloadShape;
  if (!shape || shape.topLevelOrder.length === 0) return null;
  return (
    <section className="taxonomy-payload-shape" aria-label="Provider payload shape">
      <div className="taxonomy-payload-heading">
        <strong>Payload shape</strong>
        <span>{shape.messageCount ?? 0} messages / {shape.toolCount ?? 0} tools</span>
      </div>
      <div className="taxonomy-payload-order" aria-label="Top-level provider payload order">
        {shape.topLevelOrder.map((key, index) => (
          <span key={`${key}-${index}`}>
            {index > 0 && <i aria-hidden="true">{"->"}</i>}
            <code>{key}</code>
          </span>
        ))}
      </div>
      <p>Top-level keys are the raw JSON order. Message/tool rows below follow that relative order; provider options are an aggregate view, not a single wire position.</p>
    </section>
  );
}

function TaxonomyComposition(props: { items: KindBreakdownItem[]; total: number }) {
  return (
    <section className="taxonomy-composition" aria-label="Context composition by kind">
      <div className="taxonomy-composition-heading">
        <strong>Composition</strong>
        <span>~{props.total.toLocaleString()} tokens by context kind</span>
      </div>
      <div className="taxonomy-composition-bar" aria-hidden="true">
        {props.items.map((item) => (
          <span key={item.kind} style={{ width: `${Math.max(3, item.percent)}%`, background: item.color }} />
        ))}
      </div>
      <div className="taxonomy-composition-list">
        {props.items.map((item) => (
          <span key={item.kind}>
            <i style={{ background: item.color }} aria-hidden="true" />
            {item.label} ~{item.tokens.toLocaleString()} ({Math.round(item.percent)}%)
          </span>
        ))}
      </div>
    </section>
  );
}

function TaxonomyKindGroup(props: { group: TaxonomyGroup }) {
  return (
    <section className="taxonomy-kind-group">
      <details open>
        <summary>
          <strong>{props.group.label}</strong>
          <span>{props.group.items.length} item{props.group.items.length === 1 ? "" : "s"} / ~{props.group.tokens.toLocaleString()} tokens</span>
        </summary>
        <div className="taxonomy-kind-group-items">
          {props.group.items.map((item) => (
            <TaxonomyItemView key={`${item.order}-${item.source}-${item.role}`} item={item} />
          ))}
        </div>
      </details>
    </section>
  );
}

function TaxonomyItemView(props: { item: ContextTaxonomy["items"][number] }) {
  const segments = props.item.segments ?? [];
  const openByDefault = props.item.kind === "current_user_prompt" || props.item.kind === "tool_definition" || props.item.source === "provider.payload.tools";
  const title = taxonomyItemTitle(props.item);
  const confidence = confidenceText(props.item.confidence, props.item.kind);
  return (
    <article className="taxonomy-item">
      <details className="taxonomy-item-details" open={openByDefault}>
        <summary>
          <b title="Presentation order">{props.item.order}</b>
          <span className="taxonomy-item-title">
            <strong>{title}</strong>
            <small>{props.item.source}</small>
          </span>
          {props.item.kind && <span className="taxonomy-kind-pill">{kindLabel(props.item.kind)}</span>}
        </summary>
        <div className="taxonomy-item-meta">
          <span>{props.item.label}</span>
          <span>presentation item {props.item.order}</span>
          {props.item.payloadPath && <code>{props.item.payloadPath}</code>}
          <span>~{props.item.tokenEstimate.toLocaleString()} tokens</span>
          {confidence && <span>{confidence}</span>}
        </div>
        {segments.length === 0 && <p className="taxonomy-preview">{props.item.preview}</p>}
        {segments.length === 1 && <p className="taxonomy-preview">{props.item.preview}</p>}
        <TaxonomySegments segments={segments} itemTitle={title} />
      </details>
    </article>
  );
}

function taxonomyItemTitle(item: ContextTaxonomy["items"][number]): string {
  if (item.kind === "tool_definition" || item.source === "provider.payload.tools") return item.label.replace(/^Tool definition:?\s*/i, "Tool: ");
  if (item.kind === "provider_options" || item.source === "provider.payload.options") return "Request options";
  if (item.kind === "current_user_prompt") return "Current user prompt";
  if (item.kind === "conversation_history") return "Conversation history";
  if (item.kind === "system_prompt") return "System prompt";
  if (item.kind === "developer_instructions") return "Developer instructions";
  if (item.kind === "provider_message") return item.role;
  return item.role;
}

function TaxonomySegments(props: { segments: TaxonomySegmentViewModel[]; itemTitle: string }) {
  if (props.segments.length === 0) return null;
  return (
    <div className="taxonomy-segments" aria-label={`Context pieces for ${props.itemTitle}`}>
      {props.segments.map((segment, index) => {
        const confidence = confidenceText(segment.confidence, segment.kind);
        return (
          <details key={`${segment.title}-${segment.kind}-${index}`} className="taxonomy-segment" open={shouldOpenTaxonomySegment(segment, props.segments.length)}>
            <summary>
              <span>{segment.title}</span>
              <small>{kindLabel(segment.kind)} / ~{segment.tokenEstimate.toLocaleString()} tokens{confidence ? ` / ${confidence}` : ""}</small>
            </summary>
            <ShikiCodeBlock
              code={segment.text}
              language={taxonomySegmentLanguage(segment)}
              kind={looksLikeJson(segment.text) ? "json" : "code"}
              title={segment.title}
            />
          </details>
        );
      })}
    </div>
  );
}

function buildKindBreakdown(taxonomy: ContextTaxonomy): KindBreakdownItem[] {
  const tokensByKind = new Map<ContextTaxonomyKind, number>();
  for (const item of taxonomy.items) {
    if (item.segments?.length) {
      for (const segment of item.segments) {
        tokensByKind.set(segment.kind, (tokensByKind.get(segment.kind) ?? 0) + segment.tokenEstimate);
      }
      continue;
    }
    const kind = item.kind ?? "unknown";
    tokensByKind.set(kind, (tokensByKind.get(kind) ?? 0) + item.tokenEstimate);
  }
  const total = Array.from(tokensByKind.values()).reduce((sum, value) => sum + value, 0);
  return Array.from(tokensByKind.entries())
    .map(([kind, tokens]) => ({
      kind,
      label: kindLabel(kind),
      tokens,
      percent: total > 0 ? (tokens / total) * 100 : 0,
      color: kindColor(kind)
    }))
    .sort((first, second) => second.tokens - first.tokens);
}

function groupTaxonomyItems(items: ContextTaxonomy["items"]): TaxonomyGroup[] {
  const groups = new Map<string, TaxonomyGroup>();
  for (const item of items) {
    const key = groupKey(item.kind ?? "unknown");
    const label = groupLabel(key);
    const group = groups.get(key) ?? { key, label, items: [], tokens: 0 };
    group.items.push(item);
    group.tokens += item.tokenEstimate;
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((first, second) => first.items[0].order - second.items[0].order);
}

function groupKey(kind: ContextTaxonomyKind): string {
  if (kind === "system_prompt" || kind === "developer_instructions") return "system";
  if (kind === "project_context") return "project";
  if (kind === "skill_manifest" || kind === "skill_instructions" || kind === "prompt_template") return "skills";
  if (kind === "conversation_history" || kind === "provider_message" || kind === "attachment") return "history";
  if (kind === "current_user_prompt") return "current";
  if (kind === "tool_definition") return "tools";
  if (kind === "provider_options") return "options";
  if (kind === "memory") return "memory";
  return "other";
}

function groupLabel(key: string): string {
  const labels: Record<string, string> = {
    system: "System and developer",
    project: "Project context",
    skills: "Skills and templates",
    history: "Conversation history",
    current: "Current prompt",
    tools: "Tools",
    options: "Provider options",
    memory: "Memory",
    other: "Other context"
  };
  return labels[key] ?? "Other context";
}

function taxonomySegmentLanguage(segment: TaxonomySegmentViewModel): string {
  if (segment.kind === "tool_definition" || segment.kind === "provider_options" || segment.kind === "raw_payload" || looksLikeJson(segment.text)) return "json";
  if (["project_context", "skill_manifest", "skill_instructions", "system_prompt", "developer_instructions", "prompt_template", "memory"].includes(segment.kind)) return "markdown";
  return "text";
}

function shouldOpenTaxonomySegment(segment: TaxonomySegmentViewModel, segmentCount: number): boolean {
  if (segment.kind === "tool_definition") return true;
  return segmentCount === 1 && segment.text.length < 900;
}

function kindLabel(kind: ContextTaxonomyKind): string {
  const labels: Record<ContextTaxonomyKind, string> = {
    system_prompt: "System prompt",
    developer_instructions: "Developer instructions",
    project_context: "Project context",
    skill_manifest: "Skill manifest",
    skill_instructions: "Skill instructions",
    prompt_template: "Prompt template",
    memory: "Memory",
    conversation_history: "History",
    current_user_prompt: "Current prompt",
    tool_definition: "Tool",
    provider_options: "Options",
    attachment: "Attachment",
    provider_message: "Provider message",
    raw_payload: "Raw payload",
    unknown: "Unknown"
  };
  return labels[kind];
}

function kindColor(kind: ContextTaxonomyKind): string {
  const colors: Record<ContextTaxonomyKind, string> = {
    system_prompt: "var(--ink)",
    developer_instructions: "var(--muted)",
    project_context: "var(--success)",
    skill_manifest: "var(--accent)",
    skill_instructions: "var(--accent)",
    prompt_template: "color-mix(in srgb, var(--accent) 72%, var(--success))",
    memory: "var(--success)",
    conversation_history: "var(--muted)",
    current_user_prompt: "var(--accent)",
    tool_definition: "color-mix(in srgb, var(--accent) 72%, var(--danger))",
    provider_options: "color-mix(in srgb, var(--success) 70%, var(--danger))",
    attachment: "var(--danger)",
    provider_message: "var(--muted)",
    raw_payload: "var(--ink)",
    unknown: "var(--faint)"
  };
  return colors[kind];
}

function confidenceText(confidence: number | undefined, kind: ContextTaxonomyKind | undefined): string | null {
  if (typeof confidence !== "number") return null;
  if (!kind) return null;
  if (confidence <= 0.75 || kind === "provider_message" || kind === "unknown") {
    return `${Math.round(confidence * 100)}% inferred`;
  }
  return null;
}

function assemblyReasonLabel(reason: NonNullable<ContextTaxonomy["assemblyReason"]>): string {
  const labels: Record<NonNullable<ContextTaxonomy["assemblyReason"]>, string> = {
    mock: "mock runtime",
    "no-capture": "no provider capture",
    "extension-missing": "capture extension missing"
  };
  return labels[reason];
}
