import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandMenu, type CommandMenuItem } from "../ui";
import { useI18n } from "../../i18n";
import { getBridge } from "../../desktopApi";
import type { SpotlightItem } from "../../../shared/ipc";

export function SpotlightApp() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SpotlightItem[]>([]);
  const debounceRef = useRef<number | null>(null);

  const refresh = useCallback(async (value: string) => {
    try {
      const response = await getBridge().spotlightSearch({ query: value });
      setItems(response.items);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => void refresh(query), 120);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query, refresh]);

  useEffect(() => {
    const off = getBridge().onSpotlightReset(() => {
      setQuery("");
      void refresh("");
      requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>(".spotlight-input input")?.focus();
      });
    });
    return off;
  }, [refresh]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        void getBridge().spotlightClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const execute = useCallback((item: SpotlightItem) => {
    void getBridge().spotlightExecute({
      commandId: item.commandId,
      threadId: item.threadId,
      projectId: item.projectId,
      section: item.section
    });
  }, []);

  const menuItems = useMemo<CommandMenuItem[]>(
    () =>
      items.map((item) => ({
        id: item.id,
        label: resolveLabel(item, t),
        description: resolveDescription(item, t),
        group: resolveGroup(item.group, t),
        keywords: item.keywords,
        onSelect: () => execute(item)
      })),
    [items, execute, t]
  );

  return (
    <div className="spotlight-card" data-jasmine-spotlight>
      <CommandMenu
        ariaLabel={t("spotlight.title")}
        className="spotlight-command-menu"
        inputClassName="spotlight-input"
        listClassName="spotlight-list"
        emptyLabel={t("spotlight.empty")}
        placeholder={t("spotlight.placeholder")}
        items={menuItems}
        query={query}
        onQueryChange={setQuery}
        rankItems={false}
      />
    </div>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

function resolveLabel(item: SpotlightItem, t: Translate): string {
  switch (item.id) {
    case "cmd:new-chat":
      return t("spotlight.cmd.newChat");
    case "cmd:settings":
      return t("spotlight.cmd.settings");
    case "cmd:providers":
      return t("spotlight.cmd.providers");
    default:
      return item.label;
  }
}

function resolveDescription(item: SpotlightItem, t: Translate): string | undefined {
  switch (item.id) {
    case "cmd:new-chat":
      return t("spotlight.cmd.newChat.detail");
    case "cmd:settings":
      return t("spotlight.cmd.settings.detail");
    case "cmd:providers":
      return t("spotlight.cmd.providers.detail");
    default: {
      if (item.commandId !== "open-thread") return item.description;
      const count = Number.parseInt(item.description ?? "0", 10);
      return t("search.messageCount", { count: Number.isFinite(count) ? count : 0 });
    }
  }
}

function resolveGroup(group: string | undefined, t: Translate): string | undefined {
  if (group === "commands") return t("spotlight.group.commands");
  if (group === "recent") return t("spotlight.group.recent");
  if (group === "chats") return t("spotlight.group.chats");
  return group;
}
