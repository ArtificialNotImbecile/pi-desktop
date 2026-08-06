import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { ShikiTransformer } from "@shikijs/types";
import bat from "@shikijs/langs/bat";
import bash from "@shikijs/langs/bash";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import csharp from "@shikijs/langs/csharp";
import css from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import docker from "@shikijs/langs/docker";
import dockerfile from "@shikijs/langs/dockerfile";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import jsx from "@shikijs/langs/jsx";
import less from "@shikijs/langs/less";
import lua from "@shikijs/langs/lua";
import markdown from "@shikijs/langs/markdown";
import powershell from "@shikijs/langs/powershell";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import scss from "@shikijs/langs/scss";
import sql from "@shikijs/langs/sql";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import vue from "@shikijs/langs/vue";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import githubLight from "@shikijs/themes/github-light";
import {
  transformerMetaHighlight,
  transformerMetaWordHighlight,
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
  transformerRemoveNotationEscape,
  transformerRenderIndentGuides
} from "@shikijs/transformers";
import type { CodeBlockKind } from "./codeLanguage";
import { normalizeCodeLanguage } from "./codeLanguage";

const SHIKI_THEME = "github-light";
const MAX_HIGHLIGHT_CHARS = 120_000;
const TWOSLASH_META = /\btwoslash\b/i;
const htmlCache = new Map<string, string>();
const pendingHighlights = new Map<string, Promise<string>>();
let highlighterPromise: Promise<HighlighterCore> | null = null;
let twoslashTransformerPromise: Promise<ShikiTransformer> | null = null;

export type HighlightRequest = {
  code: string;
  language?: string;
  meta?: string;
  kind?: CodeBlockKind;
};

export async function highlightCodeToHtml(request: HighlightRequest): Promise<string> {
  const language = normalizeCodeLanguage(request.language, request.kind, request.code);
  const meta = request.meta?.trim() ?? "";
  const key = JSON.stringify([language, request.kind ?? "code", meta, request.code]);
  const cached = htmlCache.get(key);
  if (cached) return cached;
  const pending = pendingHighlights.get(key);
  if (pending) return pending;
  const task = renderShikiHtml(request.code, language, meta, request.kind).then((html) => {
    htmlCache.set(key, html);
    pendingHighlights.delete(key);
    return html;
  }).catch((error) => {
    pendingHighlights.delete(key);
    throw error;
  });
  pendingHighlights.set(key, task);
  return task;
}

async function renderShikiHtml(code: string, language: string, meta: string, kind: CodeBlockKind | undefined): Promise<string> {
  if (code.length > MAX_HIGHLIGHT_CHARS) return fallbackHtml(code, language, "Output is too large for interactive highlighting.");
  try {
    const highlighter = await getHighlighter();
    const transformers = [
      transformerNotationDiff({ matchAlgorithm: "v3" }),
      transformerNotationHighlight({ matchAlgorithm: "v3" }),
      transformerNotationFocus({ matchAlgorithm: "v3" }),
      transformerNotationErrorLevel({ matchAlgorithm: "v3" }),
      transformerNotationWordHighlight({ matchAlgorithm: "v3" }),
      transformerMetaHighlight(),
      transformerMetaWordHighlight(),
      transformerRenderIndentGuides(),
      transformerRemoveNotationEscape()
    ];
    if (shouldRunTwoslash(language, meta)) {
      transformers.unshift(await getTwoslashTransformer());
    }
    return highlighter.codeToHtml(code, {
      lang: language,
      theme: SHIKI_THEME,
      meta: { __raw: meta },
      transformers
    });
  } catch (error) {
    recordHighlightError(error, language, meta);
    if (language !== "text") return renderShikiHtml(code, "text", meta, kind);
    return fallbackHtml(code, language);
  }
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [githubLight],
    langs: [
      ...bash,
      ...bat,
      ...c,
      ...cpp,
      ...csharp,
      ...css,
      ...diff,
      ...docker,
      ...dockerfile,
      ...go,
      ...html,
      ...java,
      ...javascript,
      ...json,
      ...jsonc,
      ...jsx,
      ...less,
      ...lua,
      ...markdown,
      ...powershell,
      ...python,
      ...ruby,
      ...rust,
      ...scss,
      ...sql,
      ...tsx,
      ...typescript,
      ...vue,
      ...xml,
      ...yaml
    ],
    engine: createJavaScriptRegexEngine()
  });
  return highlighterPromise;
}

async function getTwoslashTransformer(): Promise<ShikiTransformer> {
  twoslashTransformerPromise ??= Promise.all([
    import("@shikijs/twoslash/core"),
    import("twoslash/core"),
    import("typescript")
  ]).then(([twoslashShiki, twoslashCore, tsModule]) => twoslashShiki.createTransformerFactory(
    twoslashCore.createTwoslasher({
      tsModule,
      fsMap: new Map(),
      vfsRoot: "/"
    }),
    twoslashShiki.rendererRich({ queryRendering: "line" })
  )({
    explicitTrigger: true,
    throws: false
  }));
  return twoslashTransformerPromise;
}

function shouldRunTwoslash(language: string, meta: string): boolean {
  if (!TWOSLASH_META.test(meta)) return false;
  return ["ts", "tsx", "typescript"].includes(language);
}

function fallbackHtml(code: string, language: string, notice?: string): string {
  const safe = escapeHtml(code);
  const dataNotice = notice ? ` data-notice="${escapeHtml(notice)}"` : "";
  return `<pre class="shiki github-light shiki-fallback" data-language="${escapeHtml(language)}"${dataNotice}><code>${safe}</code></pre>`;
}

function recordHighlightError(error: unknown, language: string, meta: string) {
  const global = globalThis as typeof globalThis & {
    __JASMINE_SHIKI_ERRORS__?: Array<{ language: string; meta: string; message: string }>;
  };
  global.__JASMINE_SHIKI_ERRORS__ ??= [];
  global.__JASMINE_SHIKI_ERRORS__.push({
    language,
    meta,
    message: error instanceof Error ? error.message : String(error)
  });
  if (global.__JASMINE_SHIKI_ERRORS__.length > 20) global.__JASMINE_SHIKI_ERRORS__.shift();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
