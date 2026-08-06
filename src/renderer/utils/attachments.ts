import type { PickedPath } from "../../shared/ipc";

export function dedupeAttachments(items: PickedPath[]): PickedPath[] {
  return Array.from(new Map(items.map((item) => [item.path, item])).values());
}
