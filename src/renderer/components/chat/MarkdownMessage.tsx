import type { ReactNode } from "react";
import { isValidElement, memo, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ShikiCodeBlock } from "../code";

const REMARK_PLUGINS = [remarkGfm, remarkCodeBlockMeta];
const STREAMING_CHUNK_TARGET = 1_200;

declare global {
  interface Window {
    __JASMINE_HARNESS_ENABLED__?: boolean;
    __JASMINE_MARKDOWN_RENDER_LENGTHS__?: number[];
  }
}

// Memoized so streaming re-renders of the parent do not re-parse markdown for
// unchanged content. The markdown AST + fence scan are the single most expensive
// per-render cost on the chat path, so they are recomputed only when `content`
// (or the copy handler identity) actually changes.
export const MarkdownMessage = memo(function MarkdownMessage(props: { content: string; onCopyCode(code: string): void; streaming?: boolean }) {
  const { content, onCopyCode, streaming = false } = props;
  const streamCacheRef = useRef<StreamingChunkCache>(emptyStreamingChunkCache());
  const chunks = useMemo(() => {
    if (!streaming) {
      // Settlement changes the live row to a persisted row without changing
      // its text. Keep the already-painted streaming roots in that transition:
      // reparsing the completed cumulative answer here would replace every
      // Markdown node at once and reintroduce the completion flash.
      if (
        streamCacheRef.current.previousContent === content
        && streamCacheRef.current.renderedChunks.length > 0
      ) {
        return streamCacheRef.current.renderedChunks;
      }
      streamCacheRef.current = emptyStreamingChunkCache();
      return [{ start: 0, content }];
    }
    return updateStreamingChunks(streamCacheRef.current, content);
  }, [content, streaming]);

  return (
    <div className="markdown-message" data-streaming-markdown={streaming ? "true" : undefined}>
      {chunks.map((chunk, index) => (
        <MarkdownRenderSegment
          key={chunk.start}
          content={chunk.content}
          active={streaming && index === chunks.length - 1}
          onCopyCode={onCopyCode}
        />
      ))}
    </div>
  );
});

const MarkdownRenderSegment = memo(function MarkdownRenderSegment(props: {
  content: string;
  active: boolean;
  onCopyCode(code: string): void;
}) {
  const fenceAnchorRef = useRef<StreamingFenceAnchor | null>(null);
  const secondFenceAnchorRef = useRef<StreamingFenceAnchor | null>(null);
  let streamingFence = fenceAnchorRef.current
    ? readAnchoredStreamingFence(props.content, fenceAnchorRef.current)
    : null;
  if (!streamingFence && props.active) streamingFence = findOpenStreamingFence(props.content);
  fenceAnchorRef.current = streamingFence?.anchor ?? null;

  if (!streamingFence) return <MarkdownChunk content={props.content} onCopyCode={props.onCopyCode} />;

  let suffixFence = secondFenceAnchorRef.current
    ? readAnchoredStreamingFence(streamingFence.suffix, secondFenceAnchorRef.current)
    : null;
  if (!suffixFence && props.active && streamingFence.closed) suffixFence = findOpenStreamingFence(streamingFence.suffix);
  secondFenceAnchorRef.current = suffixFence?.anchor ?? null;

  return (
    <>
      {streamingFence.prefix && (
        <MarkdownChunk key="prefix" content={streamingFence.prefix} onCopyCode={props.onCopyCode} />
      )}
      <ShikiCodeBlock
        key="fence"
        code={streamingFence.code}
        language={streamingFence.language}
        meta={streamingFence.meta}
        title={formatCodeTitle(streamingFence.language, streamingFence.meta)}
        streaming={props.active && !streamingFence.closed}
        onCopy={props.onCopyCode}
      />
      {suffixFence ? (
        <div key="suffix-fence" className="streaming-fence-suffix">
          {suffixFence.prefix && <MarkdownChunk content={suffixFence.prefix} onCopyCode={props.onCopyCode} />}
          <ShikiCodeBlock
            code={suffixFence.code}
            language={suffixFence.language}
            meta={suffixFence.meta}
            title={formatCodeTitle(suffixFence.language, suffixFence.meta)}
            streaming={props.active && !suffixFence.closed}
            onCopy={props.onCopyCode}
          />
          {suffixFence.suffix && <MarkdownChunk content={suffixFence.suffix} onCopyCode={props.onCopyCode} />}
        </div>
      ) : streamingFence.suffix && (
        <MarkdownChunk key="suffix" content={streamingFence.suffix} onCopyCode={props.onCopyCode} />
      )}
    </>
  );
});

const MarkdownChunk = memo(function MarkdownChunk(props: { content: string; onCopyCode(code: string): void }) {
  const { content, onCopyCode } = props;
  const components = useMemo(
    () => markdownComponents(onCopyCode, collectCodeBlockInfos(content)),
    [content, onCopyCode]
  );
  recordMarkdownRender(content.length);
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
      {content}
    </ReactMarkdown>
  );
});

type MarkdownRenderChunk = {
  start: number;
  content: string;
};

type StreamingChunkCache = {
  previousContent: string;
  stableChunks: MarkdownRenderChunk[];
  activeStart: number;
  renderedChunks: MarkdownRenderChunk[];
};

function emptyStreamingChunkCache(): StreamingChunkCache {
  return {
    previousContent: "",
    stableChunks: [],
    activeStart: 0,
    renderedChunks: []
  };
}

/**
 * Keep completed Markdown prefixes as separate, memoized ReactMarkdown roots.
 * Streaming providers send a cumulative string, so reparsing that entire string
 * on every token turns a 15k response into quadratic work and replaces DOM that
 * was already painted. Only the unfinished suffix is allowed to change here.
 *
 * Boundaries are deliberately conservative: they must follow a blank line, be
 * outside a fenced block, and start an unindented top-level block that cannot be
 * a continuation of a list. Reference-style links and block HTML stay in one
 * root because their definitions can affect nodes elsewhere in the document.
 */
function updateStreamingChunks(cache: StreamingChunkCache, content: string): MarkdownRenderChunk[] {
  if (content === cache.previousContent) return cache.renderedChunks;

  if (!content.startsWith(cache.previousContent)) {
    cache.stableChunks = [];
    cache.activeStart = 0;
  }

  let chunkStart = cache.activeStart;
  const activeText = content.slice(chunkStart);
  const boundaries = collectSafeStreamingBoundaries(activeText);
  for (const relativeBoundary of boundaries) {
    const boundary = cache.activeStart + relativeBoundary;
    if (boundary - chunkStart < STREAMING_CHUNK_TARGET) continue;
    const candidate = content.slice(chunkStart, boundary);
    if (!canFreezeMarkdownChunk(candidate)) break;
    cache.stableChunks.push({ start: chunkStart, content: candidate });
    chunkStart = boundary;
  }

  cache.activeStart = chunkStart;
  cache.previousContent = content;
  const activeChunk = { start: chunkStart, content: content.slice(chunkStart) };
  cache.renderedChunks = activeChunk.content
    ? [...cache.stableChunks, activeChunk]
    : cache.stableChunks;
  return cache.renderedChunks;
}

function collectSafeStreamingBoundaries(markdown: string): number[] {
  const boundaries: number[] = [];
  let offset = 0;
  let sawBlankLine = false;
  let fence: { marker: "`" | "~"; length: number } | null = null;

  while (offset < markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const line = markdown.slice(offset, lineEnd).replace(/\r$/, "");

    if (fence) {
      if (isClosingFence(line, fence)) fence = null;
      sawBlankLine = false;
    } else if (!line.trim()) {
      sawBlankLine = true;
    } else {
      if (sawBlankLine && canStartIndependentMarkdownBlock(line)) boundaries.push(offset);
      sawBlankLine = false;
      fence = openingFence(line);
    }

    if (newline === -1) break;
    offset = newline + 1;
  }

  return boundaries;
}

function canStartIndependentMarkdownBlock(line: string): boolean {
  // Even one leading space may still belong to a list item or another
  // container that began in the preceding chunk. Only column-zero starts are
  // independently parseable without carrying container state across roots.
  if (/^[ \t]/.test(line)) return false;
  const topLevel = line;
  if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$)/.test(topLevel)) return false;
  if (/^\[[^\]\n]+\]:/.test(topLevel)) return false;
  return true;
}

function openingFence(line: string): { marker: "`" | "~"; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const fence = match[1];
  if (fence[0] === "`" && match[2].includes("`")) return null;
  return { marker: fence[0] as "`" | "~", length: fence.length };
}

function isClosingFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  const marker = fence.marker === "`" ? "`" : "~";
  const match = new RegExp(`^ {0,3}(${marker}{${fence.length},})[ \\t]*$`).exec(line);
  return Boolean(match);
}

function canFreezeMarkdownChunk(markdown: string): boolean {
  const prose = markdownWithoutFencedCode(markdown)
    .replace(/`[^`\n]*`/g, "")
    .replace(/(^|\n)[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]+/g, "$1");
  if (/(^|\n) {0,3}<(?!https?:\/\/|mailto:)/i.test(prose)) return false;
  // A later `[label]: /url` definition can retroactively change any earlier
  // shortcut/reference link. Keeping those constructs in one parser root is
  // more important than forcing a split for an uncommon response shape.
  if (/\[[^\]\n]+\](?:\[[^\]\n]*\])?(?![ \t]*\()/m.test(prose)) return false;
  return true;
}

function markdownWithoutFencedCode(markdown: string): string {
  const kept: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (const line of markdown.split("\n")) {
    if (fence) {
      if (isClosingFence(line.replace(/\r$/, ""), fence)) fence = null;
      continue;
    }
    const opened = openingFence(line.replace(/\r$/, ""));
    if (opened) {
      fence = opened;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

type StreamingFenceAnchor = {
  fence: { marker: "`" | "~"; length: number };
  start: number;
  contentStart: number;
  openingLine: string;
  info: string;
};

type StreamingFenceRender = {
  anchor: StreamingFenceAnchor;
  prefix: string;
  code: string;
  suffix: string;
  language: string;
  meta: string;
  closed: boolean;
};

function findOpenStreamingFence(markdown: string): StreamingFenceRender | null {
  let offset = 0;
  let open: StreamingFenceAnchor | null = null;

  while (offset < markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const openingLine = markdown.slice(offset, lineEnd);
    const line = openingLine.replace(/\r$/, "");
    if (open) {
      if (isClosingFence(line, open.fence)) open = null;
    } else {
      const fence = openingFence(line);
      // Wait for the opening line's newline. Before then it may still become a
      // longer marker or ordinary prose, so ReactMarkdown owns that tiny tail.
      // Indented fences may be nested in a list/definition; leave those to the
      // full parser because rendering them as a top-level figure changes meaning.
      if (fence && newline !== -1 && /^[`~]/.test(line)) {
        open = {
          fence,
          start: offset,
          contentStart: newline + 1,
          openingLine,
          info: line.slice(fence.length).trim()
        };
      }
    }
    if (newline === -1) break;
    offset = newline + 1;
  }

  if (!open) return null;
  const prefix = markdown.slice(0, open.start);
  if (/(^|\n) {0,3}<(?!https?:\/\/|mailto:)/i.test(prefix)) return null;
  return readAnchoredStreamingFence(markdown, open);
}

/**
 * Once a top-level fence has been painted, keep rendering that exact fence
 * through its closing marker. The surrounding streaming chunk may become a
 * stable chunk in the same update that appends the close + following prose;
 * retaining this anchor lets React preserve the Shiki figure/scroll subtree
 * instead of replacing a 15k open fence with one large ReactMarkdown root.
 */
function readAnchoredStreamingFence(markdown: string, anchor: StreamingFenceAnchor): StreamingFenceRender | null {
  const openingLineEnd = markdown.indexOf("\n", anchor.start);
  if (
    openingLineEnd === -1
    || openingLineEnd + 1 !== anchor.contentStart
    || markdown.slice(anchor.start, openingLineEnd) !== anchor.openingLine
  ) {
    return null;
  }

  let offset = anchor.contentStart;
  let closingStart = -1;
  let suffixStart = markdown.length;
  while (offset < markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const line = markdown.slice(offset, lineEnd).replace(/\r$/, "");
    if (isClosingFence(line, anchor.fence)) {
      closingStart = offset;
      suffixStart = newline === -1 ? markdown.length : newline + 1;
      break;
    }
    if (newline === -1) break;
    offset = newline + 1;
  }

  const [language = "", ...metaParts] = anchor.info.split(/\s+/).filter(Boolean);
  return {
    anchor,
    prefix: markdown.slice(0, anchor.start),
    code: markdown.slice(anchor.contentStart, closingStart === -1 ? markdown.length : closingStart),
    suffix: closingStart === -1 ? "" : markdown.slice(suffixStart),
    language,
    meta: metaParts.join(" "),
    closed: closingStart !== -1
  };
}

function recordMarkdownRender(length: number): void {
  if (typeof window === "undefined" || !window.__JASMINE_HARNESS_ENABLED__) return;
  const lengths = window.__JASMINE_MARKDOWN_RENDER_LENGTHS__ ?? [];
  lengths.push(length);
  if (lengths.length > 2_000) lengths.splice(0, lengths.length - 2_000);
  window.__JASMINE_MARKDOWN_RENDER_LENGTHS__ = lengths;
}

function markdownComponents(onCopyCode: (code: string) => void, codeBlockInfos: CodeBlockInfo[]): Components {
  let preIndex = 0;
  return {
    h1({ children }) {
      return <strong className="markdown-heading">{children}</strong>;
    },
    h2({ children }) {
      return <strong className="markdown-heading">{children}</strong>;
    },
    h3({ children }) {
      return <strong className="markdown-heading">{children}</strong>;
    },
    h4({ children }) {
      return <strong className="markdown-heading">{children}</strong>;
    },
    a({ children, href }) {
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    pre({ children }) {
      const info = codeBlockInfos[preIndex];
      preIndex += 1;
      const code = extractText(children);
      const language = extractCodeLanguage(children) || info?.language || "";
      const meta = extractCodeMeta(children) || info?.meta || "";
      return (
        <ShikiCodeBlock
          code={code}
          language={language}
          meta={meta}
          title={formatCodeTitle(language, meta)}
          onCopy={onCopyCode}
        />
      );
    },
    code({ children, className, node, ...rest }) {
      const meta = codeNodeMeta(node, rest);
      return <code className={className} data-meta={meta}>{children}</code>;
    },
    table({ children }) {
      return (
        <div className="markdown-table-scroll">
          <table>{children}</table>
        </div>
      );
    }
  };
}

type CodeBlockInfo = {
  language: string;
  meta: string;
};

function collectCodeBlockInfos(markdown: string): CodeBlockInfo[] {
  const blocks: CodeBlockInfo[] = [];
  const fencePattern = /(^|\n)(`{3,}|~{3,})([^\n]*)\n[\s\S]*?(?:\n\2)(?=\n|$)/g;
  for (const match of markdown.matchAll(fencePattern)) {
    const info = (match[3] ?? "").trim();
    const [language = "", ...metaParts] = info.split(/\s+/);
    blocks.push({ language, meta: metaParts.join(" ") });
  }
  return blocks;
}

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    const props = node.props as { children?: ReactNode };
    return extractText(props.children);
  }
  return "";
}

function extractCodeLanguage(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(extractCodeLanguage).find(Boolean) ?? "";
  if (isValidElement(node)) {
    const props = node.props as { className?: string; children?: ReactNode };
    return /language-([a-z0-9_-]+)/i.exec(props.className ?? "")?.[1] ?? extractCodeLanguage(props.children);
  }
  return "";
}

function extractCodeMeta(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(extractCodeMeta).find(Boolean) ?? "";
  if (isValidElement(node)) {
    const props = node.props as { "data-meta"?: string; children?: ReactNode };
    return props["data-meta"] ?? extractCodeMeta(props.children);
  }
  return "";
}

function remarkCodeBlockMeta() {
  return (tree: unknown) => visitMarkdownCodeNodes(tree, (node) => {
    if (!node.meta) return;
    node.data ??= {};
    node.data.hProperties ??= {};
    node.data.hProperties["data-meta"] = node.meta;
  });
}

function visitMarkdownCodeNodes(node: unknown, callback: (node: MarkdownCodeNode) => void) {
  if (!node || typeof node !== "object") return;
  const record = node as { type?: unknown; children?: unknown };
  if (record.type === "code") callback(record as MarkdownCodeNode);
  if (Array.isArray(record.children)) {
    for (const child of record.children) visitMarkdownCodeNodes(child, callback);
  }
}

type MarkdownCodeNode = {
  type: "code";
  meta?: string;
  data?: {
    hProperties?: Record<string, unknown>;
  };
};

function codeNodeMeta(node: unknown, props: Record<string, unknown>): string {
  const record = node && typeof node === "object" ? node as { data?: { meta?: unknown }; properties?: { metastring?: unknown; dataMeta?: unknown; "data-meta"?: unknown } } : null;
  const value = props["data-meta"] ?? props.dataMeta ?? record?.data?.meta ?? record?.properties?.metastring ?? record?.properties?.dataMeta ?? record?.properties?.["data-meta"];
  return typeof value === "string" ? value : "";
}

function formatCodeTitle(language: string, meta: string): string | undefined {
  const title = /(?:^|\s)title=(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(meta);
  if (title) return title[1] ?? title[2] ?? title[3];
  return language || undefined;
}
