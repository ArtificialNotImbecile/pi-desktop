import type { WebSearchResult, WebSearchSettings, WebSearchSettingsUpdateRequest } from "../../shared/ipc.js";
import { webSearchSettingsUpdateSchema } from "../../shared/schemas.js";
import type { JasmineDatabase } from "../db/database.js";
import { abortError as sharedAbortError } from "../utils/abort.js";

export function getWebSearchSettings(db: JasmineDatabase): WebSearchSettings {
  return db.getWebSearchSettings();
}

export function updateWebSearchSettings(db: JasmineDatabase, request: WebSearchSettingsUpdateRequest): WebSearchSettings {
  return db.updateWebSearchSettings(webSearchSettingsUpdateSchema.parse(request));
}

export async function searchWeb(db: JasmineDatabase, query: string, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const settings = db.getWebSearchSettings();
  if (!settings.enabled) return [];

  try {
    if (signal?.aborted) throw abortError();
    const results = process.env.JASMINE_E2E_MOCK_AI === "1"
      ? mockSearchResults(query, settings.maxResults, signal)
      : await searchExternalSources(query, settings, signal);
    db.updateWebSearchRun({ lastError: null });
    return results;
  } catch (caught) {
    const error = normalizeWebSearchError(caught, settings.timeoutMs);
    db.updateWebSearchRun({ lastError: error.message });
    throw error;
  }
}

type SearchSource = {
  name: string;
  search(query: string, settings: WebSearchSettings, timeoutMs: number, signal?: AbortSignal): Promise<WebSearchResult[]>;
};

async function searchExternalSources(query: string, settings: WebSearchSettings, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const sources: SearchSource[] = [
    { name: "DuckDuckGo HTML", search: searchDuckDuckGo },
    { name: "Bing HTML", search: searchBing }
  ];
  const deadline = Date.now() + settings.timeoutMs;
  const errors: string[] = [];

  for (let index = 0; index < sources.length; index += 1) {
    if (signal?.aborted) throw abortError();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const source = sources[index];
    const sourceTimeout = index === 0 && sources.length > 1
      ? Math.min(remaining, Math.max(1_000, Math.floor(settings.timeoutMs * 0.4)))
      : remaining;

    try {
      return await source.search(query, settings, sourceTimeout, signal);
    } catch (caught) {
      if (signal?.aborted) throw abortError();
      errors.push(`${source.name}: ${errorMessage(caught)}`);
    }
  }

  throw new Error(errors.length > 0 ? `Web search sources failed. ${errors.join(" ")}` : "Web search timed out.");
}

async function searchDuckDuckGo(
  query: string,
  settings: WebSearchSettings,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<WebSearchResult[]> {
  const url = `https://duckduckgo.com/html/?${new URLSearchParams({ q: query })}`;
  const html = await fetchSearchHtml(url, timeoutMs, signal, {
    Accept: "text/html",
    "User-Agent": "Jasmine/0.1 local desktop web search"
  });
  const results = parseDuckDuckGoResults(html).slice(0, settings.maxResults);
  if (results.length === 0) throw new Error("Web search returned no results.");
  return results;
}

async function searchBing(
  query: string,
  settings: WebSearchSettings,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<WebSearchResult[]> {
  const url = `https://www.bing.com/search?${new URLSearchParams({ q: query })}`;
  const html = await fetchSearchHtml(url, timeoutMs, signal, {
    Accept: "text/html",
    "Accept-Language": "en-US,en;q=0.9,ja;q=0.8,zh-CN;q=0.7,zh;q=0.6",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Jasmine/0.1 Safari/537.36"
  });
  const results = parseBingResults(html).slice(0, settings.maxResults);
  if (results.length === 0) throw new Error("Web search returned no results.");
  return results;
}

async function fetchSearchHtml(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  headers: Record<string, string>
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw abortError();
    const response = await fetch(url, {
      signal: controller.signal,
      headers
    });

    if (!response.ok) {
      throw new Error(`Web search request failed: ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function parseDuckDuckGoResults(html: string): WebSearchResult[] {
  const blocks = html.match(/<div class="result[\s\S]*?<\/div>\s*<\/div>/g) ?? [];
  const results: WebSearchResult[] = [];
  for (const block of blocks) {
    const titleMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);
    const url = normalizeDuckDuckGoUrl(decodeHtml(titleMatch[1]));
    if (!url || results.some((item) => item.url === url)) continue;
    results.push({
      title: cleanHtml(titleMatch[2]).slice(0, 160),
      url,
      snippet: cleanHtml(snippetMatch?.[1] ?? snippetMatch?.[2] ?? "").slice(0, 260)
    });
  }
  return results;
}

export function parseBingResults(html: string): WebSearchResult[] {
  const blocks = html.match(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>|<li class="b_ans"|$)/g) ?? [];
  const results: WebSearchResult[] = [];
  for (const block of blocks) {
    const titleMatch = block.match(/<a[^>]+href="([^"]+)"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>\s*<\/a>/)
      ?? block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/);
    if (!titleMatch) continue;
    const url = normalizeBingUrl(decodeHtml(titleMatch[1]));
    if (!url || results.some((item) => item.url === url)) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      title: cleanHtml(titleMatch[2]).slice(0, 160),
      url,
      snippet: cleanHtml(snippetMatch?.[1] ?? "").slice(0, 260)
    });
  }
  return results;
}

function normalizeBingUrl(value: string): string {
  try {
    const parsed = new URL(value, "https://www.bing.com");
    const encodedTarget = parsed.searchParams.get("u");
    if (encodedTarget) {
      const target = decodeBingTarget(encodedTarget);
      if (target) return target;
    }
    if (parsed.hostname.endsWith("bing.com") && parsed.pathname.startsWith("/ck/a")) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function decodeBingTarget(value: string): string {
  const normalized = value.startsWith("a1") ? value.slice(2) : value;
  try {
    const decoded = Buffer.from(normalized.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return decoded.startsWith("http://") || decoded.startsWith("https://") ? decoded : "";
  } catch {
    return "";
  }
}

function normalizeDuckDuckGoUrl(value: string): string {
  try {
    const parsed = new URL(value, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (parsed.hostname === "duckduckgo.com" && parsed.pathname.startsWith("/l/")) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function cleanHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function mockSearchResults(query: string, limit: number, signal?: AbortSignal): WebSearchResult[] {
  if (signal?.aborted) throw abortError();
  if (query.toLowerCase().includes("abort web search")) {
    throw abortError();
  }

  const results = [
    {
      title: `Jasmine search result for ${query}`,
      url: "https://example.com/jasmine-search",
      snippet: "Mock web evidence for the current chat request."
    },
    {
      title: "External reference",
      url: "https://example.com/reference",
      snippet: "A second deterministic result used by the product harness."
    }
  ];
  return results.slice(0, Math.max(1, limit));
}

function abortError(): Error {
  // Message is load-bearing: normalizeWebSearchError matches it to map aborts to timeouts.
  return sharedAbortError("This operation was aborted");
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function normalizeWebSearchError(caught: unknown, timeoutMs: number): Error {
  const name = caught instanceof Error ? caught.name : "";
  const message = caught instanceof Error ? caught.message : String(caught);
  const normalizedMessage = message.toLowerCase();
  if (name === "AbortError" || normalizedMessage === "aborted" || normalizedMessage === "this operation was aborted") {
    return new Error(`Web search timed out after ${timeoutMs} ms.`);
  }
  return new Error(message || "Web search failed.");
}
