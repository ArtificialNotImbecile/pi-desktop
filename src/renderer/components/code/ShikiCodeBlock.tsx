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
  onCopy?(code: string): void;
  showCopy?: boolean;
}) {
  const code = props.code.replace(/\n$/, "");
  const language = normalizeCodeLanguage(props.language, props.kind, code);
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const hasHtmlRef = useRef(false);
  const cacheKey = useMemo(() => JSON.stringify([code, language, props.meta ?? "", props.kind ?? "code"]), [code, language, props.meta, props.kind]);

  useEffect(() => {
    let alive = true;
    const run = () => {
      import("./shikiHighlighter")
        .then(({ highlightCodeToHtml }) => highlightCodeToHtml({ code, language, meta: props.meta, kind: props.kind }))
        .then((nextHtml) => {
          if (!alive) return;
          hasHtmlRef.current = true;
          setHtml(nextHtml);
        })
        .catch(() => {
          // Keep the previous highlight (or the plain-text fallback) on failure.
        });
    };
    // Highlight immediately on first paint; debounce subsequent updates so a growing
    // streamed block is only re-tokenized after it briefly stops changing.
    if (!hasHtmlRef.current) {
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
  }, [cacheKey, code, language, props.meta, props.kind]);

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
    <figure className={`code-block shiki-code-block ${props.kind ?? "code"}`} data-language={language}>
      <figcaption>
        <span>{props.title || language}</span>
        {props.showCopy !== false ? (
          <button type="button" onClick={copy} aria-label="Copy code block" title="Copy code block">
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </figcaption>
      {html ? (
        <div className="code-block-scroll" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="shiki github-light shiki-loading"><code>{code}</code></pre>
      )}
    </figure>
  );
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
