import type { ButtonHTMLAttributes, ReactNode } from "react";
import { classNames } from "./classNames";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost" | "quiet";
export type ButtonSize = "sm" | "md";

export function Button({
  children,
  className,
  disabled,
  leftIcon,
  loading = false,
  rightIcon,
  size = "md",
  type = "button",
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  leftIcon?: ReactNode;
  loading?: boolean;
  rightIcon?: ReactNode;
  size?: ButtonSize;
  variant?: ButtonVariant;
}) {
  return (
    <button
      {...props}
      className={classNames("ui-button", `ui-button-${variant}`, variant === "primary" && "primary", variant === "danger" && "danger", `ui-button-${size}`, loading && "is-loading", className)}
      disabled={disabled || loading}
      type={type}
    >
      {loading ? <span className="ui-button-spinner" aria-hidden="true" /> : leftIcon ? <span className="ui-button-icon">{leftIcon}</span> : null}
      {children ? <span className="ui-button-label">{children}</span> : null}
      {rightIcon ? <span className="ui-button-icon">{rightIcon}</span> : null}
    </button>
  );
}
