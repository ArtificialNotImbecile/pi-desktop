import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import type { CompositionEvent, FormEvent, KeyboardEvent, RefObject } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { $getRoot, $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, KEY_DOWN_COMMAND, PASTE_COMMAND, type PasteCommandType } from "lexical";
import type { ClipboardImagePasteRequest } from "../../../../shared/ipc";
import { getDomSelectionPlainTextOffset, normalizeDomPlainText, normalizePlainText, writePlainText } from "./serialization";
import { ComposerEditor } from "./ComposerEditor";
import { EnterKeyPlugin } from "./plugins/EnterKeyPlugin";
import { ComposerFocusPlugin } from "./plugins/ComposerFocusPlugin";
import { PlainTextSyncPlugin } from "./plugins/PlainTextSyncPlugin";

export type RichComposerHandle = {
  focus(): void;
};

export const RichComposer = forwardRef<RichComposerHandle, {
  ariaLabel: string;
  anchorRef?: RefObject<HTMLElement | null>;
  className?: string;
  placeholder: string;
  value: string;
  onChange(value: string): void;
  onClearError(): void;
  onCommandStateChange(value: string, cursor: number | null): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onPasteAttachment(request?: ClipboardImagePasteRequest): void;
  onSubmitFromKeyboard(): void;
}>((props, ref) => {
  const editorElementRef = useRef<HTMLDivElement | null>(null);
  const focusApiRef = useRef<{ focus(): void } | null>(null);
  const composingRef = useRef(false);
  const replaceAllOnNextPasteRef = useRef(false);
  const pasteAttachmentRequestAtRef = useRef(0);
  const clipboardFallbackTimerRef = useRef<number | null>(null);
  const initialConfig = useMemo(() => ({
    namespace: "JasmineRichComposer",
    onError(error: Error) {
      throw error;
    },
    editorState: () => {
      writePlainText(props.value);
    },
    theme: {
      paragraph: "rich-composer-paragraph",
      text: {
        bold: "rich-composer-bold"
      }
    }
  }), []);

  useImperativeHandle(ref, () => ({
    focus() {
      focusApiRef.current?.focus();
      editorElementRef.current?.focus();
    }
  }), []);

  const setEditorElement = useCallback((node: HTMLDivElement | null) => {
    editorElementRef.current = node;
    if (props.anchorRef && "current" in props.anchorRef) {
      props.anchorRef.current = node;
    }
  }, [props.anchorRef]);

  const {
    onChange,
    onClearError,
    onCommandStateChange
  } = props;

  const onPlainTextChange = useCallback((value: string, cursor: number | null, isComposing: boolean) => {
    if (isComposing) return;
    onChange(value);
    onClearError();
    if (value.length === 0 || value !== props.value) replaceAllOnNextPasteRef.current = false;
    onCommandStateChange(value, cursor);
  }, [onChange, onClearError, onCommandStateChange, props.value]);

  const getIsComposing = useCallback(() => composingRef.current, []);

  const syncFromDom = useCallback((node: HTMLElement, isComposing = composingRef.current) => {
    if (isComposing) return;
    const value = normalizeDomPlainText(node);
    const cursor = getDomSelectionPlainTextOffset(node) ?? value.length;
    onChange(value);
    onClearError();
    onCommandStateChange(value, cursor);
  }, [onChange, onClearError, onCommandStateChange]);

  const onDomInput = useCallback((event: FormEvent<HTMLDivElement>) => {
    if (composingRef.current) return;
    syncFromDom(event.currentTarget);
  }, [syncFromDom]);

  const onCompositionStart = useCallback((_event: CompositionEvent<HTMLDivElement>) => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback((event: CompositionEvent<HTMLDivElement>) => {
    composingRef.current = false;
    syncFromDom(event.currentTarget, false);
  }, [syncFromDom]);

  const cancelClipboardFallback = useCallback(() => {
    if (clipboardFallbackTimerRef.current === null) return;
    window.clearTimeout(clipboardFallbackTimerRef.current);
    clipboardFallbackTimerRef.current = null;
  }, []);

  const requestPasteAttachment = useCallback((request?: ClipboardImagePasteRequest) => {
    const now = Date.now();
    if (!request && now - pasteAttachmentRequestAtRef.current < 750) return;
    pasteAttachmentRequestAtRef.current = now;
    props.onPasteAttachment(request);
  }, [props.onPasteAttachment]);

  const scheduleClipboardFallback = useCallback(() => {
    cancelClipboardFallback();
    clipboardFallbackTimerRef.current = window.setTimeout(() => {
      clipboardFallbackTimerRef.current = null;
      requestPasteAttachment();
    }, 80);
  }, [cancelClipboardFallback, requestPasteAttachment]);

  const requestPastedImageFile = useCallback(async (file: File) => {
    try {
      const data = await file.arrayBuffer();
      requestPasteAttachment({
        name: file.name || undefined,
        mimeType: file.type || "image/png",
        data
      });
    } catch {
      requestPasteAttachment();
    }
  }, [requestPasteAttachment]);

  const onEditorKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      const root = editorElementRef.current;
      if (root) {
        event.preventDefault();
        replaceAllOnNextPasteRef.current = true;
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(root);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      scheduleClipboardFallback();
    }
    props.onKeyDown(event);
  }, [props, scheduleClipboardFallback]);

  const handlePaste = useCallback((event: PasteCommandType, root: HTMLElement | null): boolean => {
    if (!(event instanceof ClipboardEvent) || !event.clipboardData || !root) return false;
    const clipboardData = event.clipboardData;
    cancelClipboardFallback();
    const pastedImage = getPastedImageFile(clipboardData);
    if (pastedImage) {
      event.preventDefault();
      void requestPastedImageFile(pastedImage);
      return true;
    }
    const pasted = normalizePlainText(clipboardData.getData("text/plain"));
    if (!pasted) {
      if (hasAttachmentLikePaste(clipboardData)) {
        event.preventDefault();
        requestPasteAttachment();
        return true;
      }
      return false;
    }
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return false;
    event.preventDefault();
    if (replaceAllOnNextPasteRef.current) writePlainText(pasted);
    else selection.insertRawText(pasted);
    replaceAllOnNextPasteRef.current = false;
    return true;
  }, [cancelClipboardFallback, requestPastedImageFile, requestPasteAttachment]);

  useEffect(() => cancelClipboardFallback, [cancelClipboardFallback]);

  return (
    <div className={props.className ?? "rich-composer"}>
      <LexicalComposer initialConfig={initialConfig}>
        <ComposerEditor
          ariaLabel={props.ariaLabel}
          editorRef={setEditorElement}
          onCompositionEnd={onCompositionEnd}
          onCompositionStart={onCompositionStart}
          onInput={onDomInput}
          onKeyDown={onEditorKeyDown}
          placeholder={props.placeholder}
        />
        <PlainTextSyncPlugin value={props.value} onChange={onPlainTextChange} isComposing={getIsComposing} />
        <EnterKeyPlugin onSubmit={props.onSubmitFromKeyboard} />
        <PastePlugin onPaste={(event) => handlePaste(event, editorElementRef.current)} />
        <SelectAllPlugin />
        <HistoryPlugin />
        <ComposerFocusPlugin onReady={(api) => { focusApiRef.current = api; }} />
      </LexicalComposer>
    </div>
  );
});

function PastePlugin(props: {
  onPaste(event: PasteCommandType): boolean;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => editor.registerCommand(PASTE_COMMAND, props.onPaste, COMMAND_PRIORITY_HIGH), [editor, props.onPaste]);

  return null;
}

function SelectAllPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") return false;
    event.preventDefault();
    editor.update(() => {
      const root = $getRoot();
      root.select(0, root.getChildrenSize());
    });
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor]);

  return null;
}

function hasAttachmentLikePaste(clipboardData: DataTransfer): boolean {
  if (clipboardData.files.length > 0) return true;
  return Array.from(clipboardData.types).some((type) => type === "Files" || type.startsWith("image/"));
}

function getPastedImageFile(clipboardData: DataTransfer): File | null {
  for (const file of Array.from(clipboardData.files)) {
    if (file.type.startsWith("image/")) return file;
  }
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}
