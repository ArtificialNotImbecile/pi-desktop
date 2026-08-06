import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, RefObject } from "react";
import { classNames } from "./classNames";
import { FloatingSurface, type FloatingSurfacePlacement } from "./FloatingSurface";

export function MenuSurface({
  anchorRef,
  className,
  maxHeight,
  maxWidth,
  minWidth,
  onOpenChange,
  open,
  placement,
  role,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  anchorRef?: RefObject<HTMLElement | null>;
  maxHeight?: number;
  maxWidth?: number;
  minWidth?: number;
  onOpenChange?(open: boolean): void;
  open?: boolean;
  placement?: FloatingSurfacePlacement;
}) {
  const floatingRole: "menu" | "listbox" | "dialog" = role === "listbox" ? "listbox" : role === "dialog" ? "dialog" : "menu";
  if (anchorRef && typeof open === "boolean" && onOpenChange) {
    return (
      <FloatingSurface
        anchorRef={anchorRef}
        className={classNames("ui-menu-surface", className)}
        floatingProps={{ ...props, role }}
        maxHeight={maxHeight}
        maxWidth={maxWidth}
        minWidth={minWidth}
        onOpenChange={onOpenChange}
        open={open}
        placement={placement}
        role={floatingRole}
      >
        {props.children}
      </FloatingSurface>
    );
  }

  return <div {...props} className={classNames("ui-menu-surface", className)} />;
}

export function MenuSection({ className, title, ...props }: HTMLAttributes<HTMLDivElement> & { title?: ReactNode }) {
  return (
    <section {...props} className={classNames("ui-menu-section", className)}>
      {title ? <div className="ui-menu-section-title">{title}</div> : null}
      {props.children}
    </section>
  );
}

export function MenuItem({
  active,
  className,
  description,
  disabled,
  leftIcon,
  rightMeta,
  selected,
  trailing,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  description?: ReactNode;
  leftIcon?: ReactNode;
  rightMeta?: ReactNode;
  selected?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <button {...props} className={classNames("ui-menu-item", (active || selected) && "is-active", className)} type={props.type || "button"} disabled={disabled}>
      {leftIcon ? <span className="ui-menu-item-icon">{leftIcon}</span> : null}
      <span className="ui-menu-item-main">
        <span>{props.children}</span>
        {description ? <small>{description}</small> : null}
      </span>
      {trailing ?? rightMeta ? <span className="ui-menu-item-meta">{trailing ?? rightMeta}</span> : null}
    </button>
  );
}
