import { useSyncExternalStore } from "react";
import type { LocalFileDescription } from "../../../shared/ipc";
import { getBridge } from "../../desktopApi";

/**
 * Resolves the paths an assistant answer references into what the chat can show
 * for them. Deliberately module-level rather than component state: a streaming
 * message re-renders its active Markdown root on every token, and each of those
 * renders would otherwise re-ask the main process about the same paths.
 *
 * Answers are cached for the session. A path's file can change on disk, but the
 * only facts used here -- does it exist, is it a displayable image -- are stable
 * enough that re-statting on every repaint costs far more than it is worth.
 */

const descriptions = new Map<string, LocalFileDescription>();
const requested = new Set<string>();
const subscribers = new Set<() => void>();
let queued: string[] = [];
let flushHandle: ReturnType<typeof setTimeout> | null = null;

export function useLocalFileDescription(requestedPath: string, enabled: boolean): LocalFileDescription | null {
  const description = useSyncExternalStore(
    subscribe,
    () => descriptions.get(requestedPath) ?? null,
    () => null
  );
  // Requesting during render is safe here because the store only ever schedules
  // work; the state it publishes lands in a later task.
  if (enabled && !description) requestDescription(requestedPath);
  return description;
}

function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function requestDescription(requestedPath: string): void {
  if (!requestedPath || requested.has(requestedPath)) return;
  requested.add(requestedPath);
  queued.push(requestedPath);
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
    const results = await getBridge().describeLocalFiles(batch);
    for (const result of results) descriptions.set(result.requestedPath, result);
  } catch {
    // A failed lookup must not leave references stuck in a loading state
    // forever; treat the paths as unresolvable and let the UI fall back.
    for (const requestedPath of batch) {
      if (!descriptions.has(requestedPath)) {
        descriptions.set(requestedPath, unresolved(requestedPath));
      }
    }
  }
  for (const callback of subscribers) callback();
}

function unresolved(requestedPath: string): LocalFileDescription {
  return { requestedPath, path: requestedPath, name: requestedPath, exists: false, kind: "missing" };
}

/** Test seam: renderer suites mount many messages against one module instance. */
export function resetLocalFileStore(): void {
  descriptions.clear();
  requested.clear();
  queued = [];
  if (flushHandle !== null) clearTimeout(flushHandle);
  flushHandle = null;
  subscribers.clear();
}
