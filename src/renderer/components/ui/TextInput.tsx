import type { InputHTMLAttributes, ReactNode } from "react";
import { classNames } from "./classNames";

export function TextInput({
  className,
  error,
  leftIcon,
  rightAction,
  type = "text",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  error?: string | boolean;
  leftIcon?: ReactNode;
  rightAction?: ReactNode;
}) {
  return (
    <label className={classNames("ui-field", Boolean(leftIcon) && "has-left-icon", Boolean(rightAction) && "has-right-action", Boolean(error) && "has-error", className)}>
      {leftIcon ? <span className="ui-field-icon">{leftIcon}</span> : null}
      <input className="ui-input" type={type} aria-invalid={Boolean(error) || undefined} {...props} />
      {rightAction ? <span className="ui-field-action">{rightAction}</span> : null}
      {typeof error === "string" && error ? <span className="ui-field-error">{error}</span> : null}
    </label>
  );
}
