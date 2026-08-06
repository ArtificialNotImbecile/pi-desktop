import type { ReactNode } from "react";
import { isValidElement, memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ShikiCodeBlock } from "../code";

const REMARK_PLUGINS = [remarkGfm, remarkCodeBlockMeta];

// Memoized so streaming re-renders of the parent do not re-parse markdown for
// unchanged content. The markdown AST + fence scan are the single most expensive
// per-render cost on the chat path, so they are recomputed only when `content`
// (or the copy handler identity) actually changes.
export const MarkdownMessage = memo(function MarkdownMessage(props: { content: string; onCopyCode(code: string): void }) {
  const { content, onCopyCode } = props;
  const components = useMemo(
    () => markdownComponents(onCopyCode, collectCodeBlockInfos(content)),
    [content, onCopyCode]
  );
  return (
    <div className="markdown-message">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

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
