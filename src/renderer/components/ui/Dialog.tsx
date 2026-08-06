import { classNames } from "./classNames";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { Button } from "./Button";

export function Dialog(props: {
  actions?: ReactNode;
  body?: ReactNode;
  children?: ReactNode;
  className?: string;
  closeOnOutside?: boolean;
  closeLabel?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose(): void;
  open: boolean;
  showClose?: boolean;
  title: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const hasBody = props.body !== undefined && props.body !== null;
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="ui-dialog-backdrop" />
        <RadixDialog.Content
          className={classNames("ui-dialog", props.className)}
          aria-describedby={hasBody ? descriptionId : undefined}
          aria-labelledby={titleId}
          onPointerDownOutside={(event) => {
            if (props.closeOnOutside === false) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            if (document.activeElement instanceof HTMLElement) {
              restoreFocusRef.current = document.activeElement;
            }
            if (!props.initialFocusRef?.current) return;
            event.preventDefault();
            props.initialFocusRef.current.focus();
          }}
          onCloseAutoFocus={(event) => {
            const focusTarget = restoreFocusRef.current;
            if (!focusTarget?.isConnected) return;
            event.preventDefault();
            focusTarget.focus();
          }}
        >
          <header className="ui-dialog-header">
            <RadixDialog.Title asChild>
              <h2 id={titleId}>{props.title}</h2>
            </RadixDialog.Title>
            {props.showClose === false ? null : (
              <RadixDialog.Close asChild>
                <Button variant="ghost" size="sm" aria-label={props.closeLabel || "Close"}>
                  {props.closeLabel || "Close"}
                </Button>
              </RadixDialog.Close>
            )}
          </header>
          {hasBody ? (
            <RadixDialog.Description asChild>
              <div id={descriptionId} className="ui-dialog-body">{props.body}</div>
            </RadixDialog.Description>
          ) : null}
          {props.children}
          {props.actions ? <footer className="ui-dialog-actions">{props.actions}</footer> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
