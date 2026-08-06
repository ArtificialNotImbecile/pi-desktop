import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { classNames } from "./classNames";
import { Tooltip } from "./Tooltip";

export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  children: ReactNode;
  size?: "sm" | "md";
  variant?: "ghost" | "soft" | "danger" | "active";
}>(function IconButton({
  children,
  className,
  label,
  size = "md",
  type = "button",
  variant = "ghost",
  ...props
}, ref) {
  const button = (
    <button
      {...props}
      ref={ref}
      className={classNames("icon-button", "ui-icon-button", `ui-icon-button-${variant}`, `ui-icon-button-${size}`, className)}
      type={type}
      aria-label={label}
      title={props.title || label}
    >
      {children}
    </button>
  );

  return (
    <Tooltip content={props.title || label} disabled={props.disabled}>
      {button}
    </Tooltip>
  );
});
