import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { Command as CmdkCommand } from "cmdk";
import { SearchIcon } from "../icons/Icons";
import { classNames } from "./classNames";

export type CommandMenuItem = {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  icon?: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
  group?: string;
  onSelect(): void;
};

export function CommandMenu(props: {
  ariaLabel: string;
  className?: string;
  emptyClassName?: string;
  emptyLabel: string;
  inputAriaLabel?: string;
  inputAutoFocus?: boolean;
  inputClassName?: string;
  itemClassName?: string;
  itemRole?: "button" | "option";
  items: CommandMenuItem[];
  listClassName?: string;
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
  onQueryChange?(query: string): void;
  onSelectedIdChange?(id: string): void;
  placeholder?: string;
  preserveItemFocus?: boolean;
  query?: string;
  rankItems?: boolean;
  rootProps?: Omit<HTMLAttributes<HTMLDivElement>, "defaultValue" | "onChange" | "onKeyDown">;
  selectedId?: string;
  shortcut?: string;
  showInput?: boolean;
}) {
  const query = props.query ?? "";
  const visibleItems = props.rankItems === false ? props.items : rankCommandMenuItems(props.items, query);
  const groups = groupCommandItems(visibleItems);
  const showInput = props.showInput !== false;
  const itemRole = props.itemRole ?? "button";

  return (
    <CmdkCommand
      {...props.rootProps}
      className={classNames("command-menu", props.className, props.rootProps?.className)}
      label={props.ariaLabel}
      loop
      shouldFilter={false}
      value={props.selectedId}
      onValueChange={props.onSelectedIdChange}
      onKeyDown={props.onKeyDown}
    >
      {showInput ? (
        <CommandMenuInput
          ariaLabel={props.inputAriaLabel ?? props.placeholder ?? props.ariaLabel}
          autoFocus={props.inputAutoFocus ?? true}
          className={props.inputClassName}
          onQueryChange={props.onQueryChange}
          placeholder={props.placeholder}
          query={query}
          shortcut={props.shortcut}
        />
      ) : null}
      <CommandMenuList className={props.listClassName}>
        {visibleItems.length === 0 ? (
          <CommandMenuEmpty className={props.emptyClassName}>{props.emptyLabel}</CommandMenuEmpty>
        ) : groups.map((group) => (
          <CommandMenuGroup key={group.name || "__default"} heading={group.name}>
            {group.items.map((item) => (
              <CommandMenuItemRow
                key={item.id}
                item={item}
                className={props.itemClassName}
                role={itemRole}
                preserveFocus={props.preserveItemFocus}
              />
            ))}
          </CommandMenuGroup>
        ))}
      </CommandMenuList>
    </CmdkCommand>
  );
}

export function CommandMenuInput(props: {
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  onQueryChange?(query: string): void;
  placeholder?: string;
  query: string;
  shortcut?: string;
}) {
  return (
    <div className={classNames("command-input", props.className)}>
      <SearchIcon />
      <CmdkCommand.Input
        autoFocus={props.autoFocus}
        value={props.query}
        onValueChange={props.onQueryChange}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
      />
      {props.shortcut ? <span>{props.shortcut}</span> : null}
    </div>
  );
}

export function CommandMenuList(props: HTMLAttributes<HTMLDivElement>) {
  return <CmdkCommand.List {...props} className={classNames("command-list", props.className)} />;
}

export function CommandMenuGroup(props: { children: ReactNode; heading?: string }) {
  if (!props.heading) return <>{props.children}</>;
  return (
    <CmdkCommand.Group className="command-menu-group" heading={props.heading}>
      {props.children}
    </CmdkCommand.Group>
  );
}

export function CommandMenuEmpty(props: { children: ReactNode; className?: string }) {
  return <CmdkCommand.Empty className={classNames("command-empty", props.className)}>{props.children}</CmdkCommand.Empty>;
}

function CommandMenuItemRow(props: {
  className?: string;
  item: CommandMenuItem;
  preserveFocus?: boolean;
  role: "button" | "option";
}) {
  return (
    <CmdkCommand.Item
      asChild
      disabled={props.item.disabled}
      keywords={props.item.keywords}
      value={props.item.id}
      onSelect={() => {
        if (!props.item.disabled) props.item.onSelect();
      }}
    >
      <button
        className={classNames("command-menu-row", props.className)}
        type="button"
        role={props.role}
        disabled={props.item.disabled}
        onMouseDown={props.preserveFocus ? (event) => event.preventDefault() : undefined}
      >
        {props.item.icon ? <span className="command-menu-icon">{props.item.icon}</span> : null}
        <span className="command-menu-main">
          <strong>{props.item.label}</strong>
          {props.item.description ? <small>{props.item.description}</small> : null}
        </span>
        {props.item.trailing ? <span className="command-menu-trailing">{props.item.trailing}</span> : null}
      </button>
    </CmdkCommand.Item>
  );
}

export function rankCommandMenuItems(items: CommandMenuItem[], query: string): CommandMenuItem[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return items;
  return items
    .map((item, index) => ({ item, index, score: commandMenuItemScore(item, normalized) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

function commandMenuItemScore(item: CommandMenuItem, query: string): number {
  const label = item.label.toLowerCase();
  if (label === query) return 100;
  if (label.startsWith(query)) return 90;
  if (wordBoundaryIncludes(label, query)) return 80;
  if (item.keywords?.some((keyword) => keyword.toLowerCase().includes(query))) return 70;
  if (item.description?.toLowerCase().includes(query)) return 60;
  if (label.includes(query)) return 50;
  return 0;
}

function groupCommandItems(items: CommandMenuItem[]): Array<{ name: string; items: CommandMenuItem[] }> {
  const groups = new Map<string, CommandMenuItem[]>();
  for (const item of items) {
    const group = item.group ?? "";
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  return Array.from(groups.entries()).map(([name, groupItems]) => ({ name, items: groupItems }));
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function wordBoundaryIncludes(value: string, query: string): boolean {
  return value.split(/[\s._:/\\-]+/).some((part) => part.startsWith(query));
}
