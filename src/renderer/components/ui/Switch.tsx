import * as RadixSwitch from "@radix-ui/react-switch";
import type { ComponentPropsWithoutRef } from "react";
import { classNames } from "./classNames";

export function Switch({
  checked,
  className,
  disabled,
  offLabel = "",
  onChange,
  onLabel = "",
  showLabel = false,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof RadixSwitch.Root>, "checked" | "onCheckedChange" | "onChange"> & {
  checked: boolean;
  offLabel?: string;
  onChange(checked: boolean): void;
  onLabel?: string;
  showLabel?: boolean;
}) {
  const label = checked ? onLabel : offLabel;
  return (
    <RadixSwitch.Root
      {...props}
      className={classNames("ui-switch", checked && "is-on", className)}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
    >
      <span className="ui-switch-track" aria-hidden="true">
        <RadixSwitch.Thumb className="ui-switch-thumb" />
      </span>
      {showLabel && label ? <span className="ui-switch-label">{label}</span> : null}
    </RadixSwitch.Root>
  );
}
