import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeBlockKind } from "./codeLanguage";
import { normalizeCodeLanguage } from "./codeLanguage";

// While a code block is still streaming its content changes on every chunk. Re-highlighting
// synchronously each time is expensive and clearing the HTML first causes a visible flash
// between the highlighted and plain-text states. We keep the previously highlighted HTML
// visible (stale-while-revalidate) and debounce re-highlighting so a fast stream only
// triggers a highlight once the code settles for a short moment.
const REHIGHLIGHT_DEBOUNCE_MS = 140;

export function ShikiCodeBlock(props: {
  code: string;
  language?: string;
  meta?: string;
  title?: string;
  kind?: CodeBlockKind;
  streaming?: boolean;
  onCopy?(code: string): void;
  showCopy?: boolean;
}) {
  const code = props.code.replace(/\n$/, "");
  const language = normalizeCodeLanguage(props.language, props.kind, code);
  const [highlighted, setHighlighted] = useState<HighlightedCode | null>(null);
  const [copied, setCopied] = useState(false);
  const hasHtmlRef = useRef(false);

  useEffect(() => {
    let alive = true;
    const run = () => {
      import("./shikiHighlighter")
        .then(({ highlightCodeToHtml }) => highlightCodeToHtml({ code, language, meta: props.meta, kind: props.kind }))
        .then((nextHtml) => {
          if (!alive) return;
          hasHtmlRef.current = true;
          setHighlighted({
            html: nextHtml,
            code,
            language,
            meta: props.meta ?? "",
            kind: props.kind
          });
        })
        .catch(() => {
          // Keep the previous highlight (or the plain-text fallback) on failure.
        });
    };
    // Static blocks highlight immediately on first paint. A growing open fence
    // starts with the plain-text fallback and waits for a quiet interval, so a
    // fast stream does not launch a discarded highlight for every cumulative tick.
    if (!props.streaming && !hasHtmlRef.current) {
      run();
      return () => {
        alive = false;
      };
    }
    const timer = window.setTimeout(run, REHIGHLIGHT_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [code, language, props.meta, props.kind, props.streaming]);

  const visibleHtml = useMemo(
    () => mergeStreamingCode(highlighted, { code, language, meta: props.meta ?? "", kind: props.kind }),
    [code, highlighted, language, props.meta, props.kind]
  );

  const copy = () => {
    if (props.onCopy) {
      props.onCopy(code);
    } else {
      void navigator.clipboard?.writeText(code);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 900);
  };

  return (
    <figure
      className={`code-block shiki-code-block ${props.kind ?? "code"}`}
      data-language={language}
      data-code-length={code.length}
      data-highlighted-length={highlighted?.code.length ?? 0}
    >
      <figcaption>
        <span>{props.title || language}</span>
        {props.showCopy !== false ? (
          <button type="button" onClick={copy} aria-label="Copy code block" title="Copy code block">
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </figcaption>
      {visibleHtml ? (
        <div className="code-block-scroll" dangerouslySetInnerHTML={{ __html: visibleHtml }} />
      ) : (
        <div className="code-block-scroll">
          <pre className="shiki github-light shiki-loading"><code>{code}</code></pre>
        </div>
      )}
    </figure>
  );
}

type HighlightedCode = {
  html: string;
  code: string;
  language: string;
  meta: string;
  kind?: CodeBlockKind;
};

/**
 * Preserve the last highlighted prefix while a cumulative stream grows, but
 * append the not-yet-highlighted source to the same Shiki line tree. This
 * makes every token visible immediately without duplicating source or changing
 * the block's line geometry when the debounced highlight catches up.
 */
function mergeStreamingCode(
  highlighted: HighlightedCode | null,
  current: Omit<HighlightedCode, "html">
): string | null {
  if (!highlighted) return null;
  if (
    highlighted.language !== current.language
    || highlighted.meta !== current.meta
    || highlighted.kind !== current.kind
    || !current.code.startsWith(highlighted.code)
  ) {
    return null;
  }

  const suffix = current.code.slice(highlighted.code.length);
  if (!suffix) return highlighted.html;

  const codeClose = highlighted.html.lastIndexOf("</code>");
  if (codeClose === -1) return null;
  const lastLineClose = highlighted.html.lastIndexOf("</span>", codeClose);
  if (lastLineClose === -1) return null;

  const [firstLine, ...remainingLines] = suffix.split("\n");
  const appendedLines = remainingLines
    .map((line) => `\n<span class="line">${escapeCodeText(line)}</span>`)
    .join("");
  return `${highlighted.html.slice(0, lastLineClose)}${escapeCodeText(firstLine)}${highlighted.html.slice(lastLineClose, codeClose)}${appendedLines}${highlighted.html.slice(codeClose)}`;
}

function escapeCodeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function DiffBlock(props: { code: string; title?: string; onCopy?(code: string): void }) {
  return <ShikiCodeBlock code={props.code} language="diff" kind="diff" title={props.title ?? "diff"} onCopy={props.onCopy} />;
}

export function JsonBlock(props: { code: string; title?: string; onCopy?(code: string): void }) {
  return <ShikiCodeBlock code={props.code} language="json" kind="json" title={props.title ?? "json"} onCopy={props.onCopy} />;
}

export function AnsiBlock(props: { code: string; title?: string; onCopy?(code: string): void }) {
  return <ShikiCodeBlock code={props.code} language="ansi" kind="ansi" title={props.title ?? "terminal"} onCopy={props.onCopy} />;
}

export function StackTraceBlock(props: { code: string; title?: string; onCopy?(code: string): void }) {
  return <ShikiCodeBlock code={props.code} kind="stack" title={props.title ?? "stack trace"} onCopy={props.onCopy} />;
}
