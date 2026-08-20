import { useSyncExternalStore } from "react";
import type { LocalFileDescription } from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";

/**
 * Resolves the paths an assistant answer references into what the chat can show
 * for them. Deliberately module-level rather than component state: a streaming
 * message re-renders its active Markdown root on every token, and each of those
 * renders would otherwise re-ask the main process about the same paths.
 *
 * Answers are cached for one Markdown root. That keeps a streaming message from
 * re-statting the same path on every token while allowing a later answer to see
 * a file that was created or replaced during the session.
 */

let descriptions = new WeakMap<object, Map<string, LocalFileDescription>>();
let requested = new WeakMap<object, Set<string>>();
const subscribers = new Set<() => void>();
let queued: Array<{ scope: object; requestedPath: string }> = [];
let flushHandle: ReturnType<typeof setTimeout> | null = null;

export function useLocalFileDescription(
  requestedPath: string,
  enabled: boolean,
  scope: object
): LocalFileDescription | null {
  const description = useSyncExternalStore(
    subscribe,
    () => descriptions.get(scope)?.get(requestedPath) ?? null,
    () => null
  );
  // Requesting during render is safe here because the store only ever schedules
  // work; the state it publishes lands in a later task.
  if (enabled && !description) requestDescription(requestedPath, scope);
  return description;
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function requestDescription(requestedPath: string, scope: object): void {
  if (!requestedPath) return;
  const scopeRequests = requested.get(scope) ?? new Set<string>();
  if (scopeRequests.has(requestedPath)) return;
  scopeRequests.add(requestedPath);
  requested.set(scope, scopeRequests);
  queued.push({ scope, requestedPath });
  if (flushHandle !== null) return;
  // One frame of collection turns a message full of file references into a
  // single round trip instead of one per link.
  flushHandle = setTimeout(() => {
    flushHandle = null;
    void flush();
  }, 16);
}

async function flush(): Promise<void> {
  const batch = queued;
  queued = [];
  if (batch.length === 0) return;

  try {
    const paths = [...new Set(batch.map((entry) => entry.requestedPath))];
    const results = await getBridge().describeLocalFiles(paths);
    const byPath = new Map(results.map((result) => [result.requestedPath, result]));
    for (const entry of batch) {
      const scopeDescriptions = descriptions.get(entry.scope) ?? new Map<string, LocalFileDescription>();
      scopeDescriptions.set(
        entry.requestedPath,
        byPath.get(entry.requestedPath) ?? unresolved(entry.requestedPath)
      );
      descriptions.set(entry.scope, scopeDescriptions);
    }
  } catch {
    // A failed lookup must not leave references stuck in a loading state
    // forever; treat the paths as unresolvable and let the UI fall back.
    for (const entry of batch) {
      const scopeDescriptions = descriptions.get(entry.scope) ?? new Map<string, LocalFileDescription>();
      scopeDescriptions.set(entry.requestedPath, unresolved(entry.requestedPath));
      descriptions.set(entry.scope, scopeDescriptions);
    }
  }
  for (const callback of subscribers) callback();
}

function unresolved(requestedPath: string): LocalFileDescription {
  return { requestedPath, path: requestedPath, name: requestedPath, exists: false, kind: "missing" };
}

/** Test seam: renderer suites mount many messages against one module instance. */
export function resetLocalFileStore(): void {
  descriptions = new WeakMap<object, Map<string, LocalFileDescription>>();
  requested = new WeakMap<object, Set<string>>();
  queued = [];
  if (flushHandle !== null) clearTimeout(flushHandle);
  flushHandle = null;
  subscribers.clear();
}
