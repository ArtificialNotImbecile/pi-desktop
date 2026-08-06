import type { WebSearchResult } from "../../shared/ipc.js";

export function mergeWebSearchResultsInto(target: WebSearchResult[], results: WebSearchResult[]): void {
  for (const result of results) {
    if (!target.some((item) => item.url === result.url)) target.push(result);
  }
}

export function mergeWebSearchResults(first: WebSearchResult[], second: WebSearchResult[]): WebSearchResult[] {
  const merged = [...first];
  mergeWebSearchResultsInto(merged, second);
  return merged;
}
