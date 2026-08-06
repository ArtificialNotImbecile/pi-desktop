import type { HTMLAttributes } from "react";
import { classNames } from "./classNames";

export function Toolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={classNames("ui-toolbar", className)} />;
}
