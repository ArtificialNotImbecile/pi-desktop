import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { normalizePlainText, readPlainText, writePlainText } from "../serialization";

export function PlainTextSyncPlugin(props: {
  value: string;
  onChange(value: string, cursor: number | null, isComposing: boolean): void;
  isComposing?(): boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const { isComposing: isDomComposing, onChange, value: externalValue } = props;

  useEffect(() => {
    const current = editor.getEditorState().read(() => readPlainText());
    const next = normalizePlainText(externalValue);
    if (current === next) return;
    editor.update(() => {
      writePlainText(next);
    }, { tag: "external-composer-sync" });
  }, [editor, externalValue]);

  useEffect(() => editor.registerUpdateListener(({ editorState, tags }) => {
    if (tags.has("external-composer-sync")) return;
    editorState.read(() => {
      const isComposing = editor.isComposing() || Boolean(isDomComposing?.());
      if (isComposing) return;
      const value = readPlainText();
      const cursor = getCursorOffset(editor.getRootElement()) ?? value.length;
      onChange(value, cursor, isComposing);
    });
  }), [editor, isDomComposing, onChange]);

  return null;
}

function getCursorOffset(root: HTMLElement | null): number | null {
  if (!root) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.endContainer)) return null;
  const beforeRange = range.cloneRange();
  beforeRange.selectNodeContents(root);
  beforeRange.setEnd(range.endContainer, range.endOffset);
  return normalizePlainText(beforeRange.toString()).length;
}
