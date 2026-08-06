import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

export function ComposerFocusPlugin({ onReady }: {
  onReady(api: { focus(): void }): void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    onReady({
      focus() {
        editor.focus();
      }
    });
  }, [editor, onReady]);

  return null;
}
