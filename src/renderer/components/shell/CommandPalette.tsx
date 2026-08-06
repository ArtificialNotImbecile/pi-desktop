import { useEffect, useMemo, useState } from "react";
import { CommandMenu, FadeScale, Presence, type CommandMenuItem } from "../ui";
import { useI18n } from "../../i18n";

export type CommandPaletteItem = {
  id: string;
  label: string;
  detail: string;
  shortcut?: string;
  action(): void;
};

export function CommandPalette(props: {
  open: boolean;
  commands: CommandPaletteItem[];
  onClose(): void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (props.open) setQuery("");
  }, [props.open]);

  const items = useMemo<CommandMenuItem[]>(() => props.commands.map((command) => ({
    id: command.id,
    label: command.label,
    description: command.detail,
    keywords: [command.shortcut ?? ""],
    trailing: command.shortcut ? <kbd>{command.shortcut}</kbd> : undefined,
    group: commandGroup(command.id, t),
    onSelect: () => run(command)
  })), [props.commands, t]);

  function run(command: CommandPaletteItem) {
    props.onClose();
    command.action();
  }

  return (
    <Presence>
      {props.open ? (
        <div className="command-backdrop" onMouseDown={props.onClose}>
          <FadeScale className="command-panel" onMouseDown={(event) => event.stopPropagation()} aria-label={t("command.title")}>
            <CommandMenu
              ariaLabel={t("command.title")}
              emptyLabel={t("command.empty")}
              inputAriaLabel={t("command.placeholder")}
              items={items}
              placeholder={t("command.placeholder")}
              query={query}
              onQueryChange={setQuery}
              shortcut="Ctrl K"
            />
          </FadeScale>
        </div>
      ) : null}
    </Presence>
  );
}

function commandGroup(id: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (id === "new-chat" || id === "search-chats" || id === "toggle-sidebar") return t("command.group.chat");
  if (id === "activity" || id === "ui-catalog") return t("command.group.panels");
  if (id === "memory" || id === "web-search") return t("command.group.runtime");
  return t("command.group.settings");
}
