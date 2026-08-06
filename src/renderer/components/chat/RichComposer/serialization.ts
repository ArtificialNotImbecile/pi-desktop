import { $createParagraphNode, $generateNodesFromRawText, $getRoot } from "lexical";

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
