import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from "lexical";

export function EnterKeyPlugin({ onSubmit }: {
  onSubmit(): void;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
    if (event?.shiftKey) {
      event.preventDefault();
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertLineBreak();
      });
      return true;
    }
    event?.preventDefault();
    onSubmit();
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor, onSubmit]);

  return null;
}
