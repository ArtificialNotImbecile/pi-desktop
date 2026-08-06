import type { HTMLAttributes, ReactNode } from "react";
import { classNames } from "./classNames";

export function StatusPill({
  children,
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  tone?: "neutral" | "success" | "danger" | "accent" | "warning";
}) {
  return (
    <span {...props} className={classNames("ui-status-pill", `ui-status-${tone}`, className)}>
      {children}
    </span>
  );
}
