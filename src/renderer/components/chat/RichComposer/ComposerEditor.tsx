import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import type { CompositionEvent, FormEvent, KeyboardEvent, ReactNode, Ref } from "react";

export function ComposerEditor(props: {
  ariaLabel: string;
  placeholder: string;
  editorRef: Ref<HTMLDivElement>;
  onCompositionEnd(event: CompositionEvent<HTMLDivElement>): void;
  onCompositionStart(event: CompositionEvent<HTMLDivElement>): void;
  onInput(event: FormEvent<HTMLDivElement>): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
}) {
  return (
    <PlainTextPlugin
      contentEditable={
        <ContentEditable
          ref={props.editorRef}
          className="rich-composer-editor"
          aria-label={props.ariaLabel}
          aria-placeholder={props.placeholder}
          placeholder={<div className="rich-composer-placeholder">{props.placeholder}</div>}
          spellCheck
          onCompositionEnd={props.onCompositionEnd}
          onCompositionStart={props.onCompositionStart}
          onInput={props.onInput}
          onKeyDown={props.onKeyDown}
        />
      }
      placeholder={null}
      ErrorBoundary={RichComposerErrorBoundary}
    />
  );
}

function RichComposerErrorBoundary(props: { children: ReactNode }) {
  return <>{props.children}</>;
}
