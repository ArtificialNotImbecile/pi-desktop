import type { SelectHTMLAttributes } from "react";
import { classNames } from "./classNames";

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className={classNames("ui-field", "ui-field-select", className)}>
      <select className="ui-select" {...props} />
    </label>
  );
}
