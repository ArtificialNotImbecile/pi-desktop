import * as RadixTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { classNames } from "./classNames";

export function Tabs<T extends string>(props: {
  ariaLabel: string;
  tabs: Array<{ id: T; label: ReactNode; disabled?: boolean }>;
  value: T;
  onChange(value: T): void;
  className?: string;
}) {
  return (
    <RadixTabs.Root
      value={props.value}
      onValueChange={(value) => props.onChange(value as T)}
    >
      <RadixTabs.List className={classNames("ui-tabs", props.className)} aria-label={props.ariaLabel}>
        {props.tabs.map((tab) => (
          <RadixTabs.Trigger
            key={tab.id}
            className={classNames("ui-tab", props.value === tab.id && "is-active")}
            value={tab.id}
            disabled={tab.disabled}
          >
            {tab.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
    </RadixTabs.Root>
  );
}
