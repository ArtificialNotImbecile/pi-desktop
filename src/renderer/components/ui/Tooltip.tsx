import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { classNames } from "./classNames";

export function Tooltip(props: {
  children: ReactNode;
  className?: string;
  content: ReactNode;
  delayDuration?: number;
  disabled?: boolean;
}) {
  if (props.disabled || !props.content) return <>{props.children}</>;
  return (
    <RadixTooltip.Provider delayDuration={props.delayDuration ?? 350} skipDelayDuration={120}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{props.children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className={classNames("ui-tooltip", props.className)} sideOffset={6}>
            {props.content}
            <RadixTooltip.Arrow className="ui-tooltip-arrow" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
