import { useLayoutEffect } from "react";
import type { HTMLAttributes, RefObject, ReactNode } from "react";
import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole
} from "@floating-ui/react";
import { classNames } from "./classNames";
import { FadeSlide, Presence } from "./Motion";

export type FloatingSurfacePlacement = "top-start" | "top-end" | "bottom-start" | "bottom-end" | "right" | "right-start" | "left" | "left-start";

export function FloatingSurface(props: {
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  floatingProps?: HTMLAttributes<HTMLDivElement>;
  maxHeight?: number;
  maxWidth?: number;
  minWidth?: number;
  modal?: boolean;
  onOpenChange(open: boolean): void;
  open: boolean;
  placement?: FloatingSurfacePlacement;
  role?: "menu" | "listbox" | "dialog";
}) {
  const { context, floatingStyles, refs } = useFloating({
    open: props.open,
    placement: props.placement ?? "bottom-start",
    strategy: "fixed",
    transform: false,
    onOpenChange: props.onOpenChange,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, availableWidth, elements }) {
          const maxHeight = Math.max(120, Math.min(props.maxHeight ?? 360, availableHeight));
          const maxWidth = Math.max(160, Math.min(props.maxWidth ?? availableWidth, availableWidth));
          Object.assign(elements.floating.style, {
            "--floating-max-height": `${maxHeight}px`,
            "--floating-max-width": `${maxWidth}px`,
            "--floating-min-width": props.minWidth ? `${props.minWidth}px` : undefined
          });
        }
      })
    ]
  });

  useLayoutEffect(() => {
    refs.setReference(props.anchorRef.current);
  }, [props.anchorRef, refs]);

  const dismiss = useDismiss(context, { escapeKey: true, outsidePress: true });
  const role = useRole(context, { role: props.role ?? "menu" });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  if (!props.anchorRef.current) return null;

  const surface = (
    <FadeSlide
      {...getFloatingProps(props.floatingProps)}
      ref={refs.setFloating}
      className={classNames("ui-floating-surface", props.className, props.floatingProps?.className)}
      distance={6}
      duration={0.16}
      style={floatingStyles}
    >
      {props.children}
    </FadeSlide>
  );

  return (
    <FloatingPortal>
      <Presence>
        {props.open ? (
          props.modal ? (
            <FloatingFocusManager context={context} modal={props.modal}>
              {surface}
            </FloatingFocusManager>
          ) : surface
        ) : null}
      </Presence>
    </FloatingPortal>
  );
}
