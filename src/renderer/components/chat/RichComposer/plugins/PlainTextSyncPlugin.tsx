import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { getSelectionPlainTextOffset, normalizePlainText, readPlainText, writePlainText } from "../serialization";

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
      const cursor = getSelectionPlainTextOffset() ?? value.length;
      onChange(value, cursor, isComposing);
    });
  }), [editor, isDomComposing, onChange]);

  return null;
}
