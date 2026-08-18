import { $createParagraphNode, $createRangeSelection, $generateNodesFromRawText, $getRoot, $getSelection, $isRangeSelection } from "lexical";

export function readPlainText(): string {
  return normalizePlainText($getRoot().getTextContent());
}

export function writePlainText(text: string): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  const nodes = $generateNodesFromRawText(text);
  if (nodes.length > 0) paragraph.append(...nodes);
  root.append(paragraph);
  root.selectEnd();
}

export function normalizePlainText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
}

export function normalizeDomPlainText(node: HTMLElement): string {
  return normalizePlainText(node.innerText || node.textContent || "").replace(/\n$/, "");
}

export function getDomSelectionPlainTextOffset(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.endContainer)) return null;
  const offset = getDomPointPlainTextOffset(root, range.endContainer, range.endOffset);
  return offset === null ? null : Math.min(offset, normalizeDomPlainText(root).length);
}

export function getSelectionPlainTextOffset(): number | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const root = $getRoot();
  const prefix = $createRangeSelection();
  prefix.anchor.set(root.getKey(), 0, "element");
  prefix.focus.set(selection.anchor.key, selection.anchor.offset, selection.anchor.type);
  return normalizePlainText(prefix.getTextContent()).length;
}

function getDomPointPlainTextOffset(node: Node, target: Node, targetOffset: number): number | null {
  if (node === target) {
    if (node.nodeType === Node.TEXT_NODE) {
      return normalizePlainText((node.textContent ?? "").slice(0, targetOffset)).length;
    }
    let offset = 0;
    for (let index = 0; index < Math.min(targetOffset, node.childNodes.length); index += 1) {
      offset += getDomPlainTextSize(node.childNodes[index]);
    }
    return offset;
  }

  let offset = 0;
  for (const child of Array.from(node.childNodes)) {
    if (child === target || child.contains(target)) {
      const nested = getDomPointPlainTextOffset(child, target, targetOffset);
      return nested === null ? null : offset + nested;
    }
    offset += getDomPlainTextSize(child);
  }
  return null;
}

function getDomPlainTextSize(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return normalizePlainText(node.textContent ?? "").length;
  if (node.nodeName === "BR") return 1;
  return Array.from(node.childNodes).reduce((size, child) => size + getDomPlainTextSize(child), 0);
}
