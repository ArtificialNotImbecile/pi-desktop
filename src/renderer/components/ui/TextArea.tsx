import { forwardRef, type TextareaHTMLAttributes } from "react";
import { classNames } from "./classNames";

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & {
  error?: string | boolean;
}>(function TextArea({
  className,
  error,
  ...props
}, ref) {
  return (
    <label className={classNames("ui-field", "ui-field-textarea", error && "has-error", className)}>
      <textarea ref={ref} className="ui-textarea" aria-invalid={Boolean(error) || undefined} {...props} />
      {typeof error === "string" && error ? <span className="ui-field-error">{error}</span> : null}
    </label>
  );
});
