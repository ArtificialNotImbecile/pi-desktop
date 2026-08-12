import { useMemo } from "react";
import type { CommandPaletteItem } from "../components/shell/CommandPalette";
import type { I18nKey } from "../i18n";
import type { JasmineRoute } from "../navigation/routes";

export function useCommandPaletteCommands(input: {
  sidebarCollapsed: boolean;
  navigate(route: JasmineRoute): void;
  closeFloatingSurfaces(): void;
  openSearch(): void;
  openMemory(): void;
  openActivity(): void;
  openUiCatalog(): void;
  toggleSidebar(): void;
  t(key: I18nKey, values?: Record<string, string | number>): string;
}): CommandPaletteItem[] {
  const { t } = input;
  return useMemo(() => [
    {
      id: "new-chat",
      label: t("command.newChat"),
      detail: t("command.newChat.detail"),
      shortcut: "Ctrl N",
      action: () => input.navigate({ name: "newChat" })
    },
    {
      id: "search-chats",
      label: t("command.searchChats"),
      detail: t("command.searchChats.detail"),
      shortcut: "Ctrl F",
      action: () => {
        input.closeFloatingSurfaces();
        input.openSearch();
      }
    },
    {
      id: "provider-settings",
      label: t("command.providerSettings"),
      detail: t("command.providerSettings.detail"),
      action: () => {
        input.closeFloatingSurfaces();
        input.navigate({ name: "settings", section: "providers" });
      }
    },
    {
      id: "memory",
      label: t("command.memory"),
      detail: t("command.memory.detail"),
      action: () => {
        input.closeFloatingSurfaces();
        input.openMemory();
      }
    },
    {
      id: "skills",
      label: t("command.skills"),
      detail: t("command.skills.detail"),
      action: () => {
        input.closeFloatingSurfaces();
        input.navigate({ name: "settings", section: "skills" });
      }
    },
    {
      id: "prompt-templates",
      label: t("command.prompts"),
      detail: t("command.prompts.detail"),
      action: () => {
        input.closeFloatingSurfaces();
        input.navigate({ name: "settings", section: "prompts" });
      }
    },
    {
      id: "plugins",
      label: t("command.plugins"),
      detail: t("command.plugins.detail"),
      action: () => {
        input.closeFloatingSurfaces();
        input.navigate({ name: "settings", section: "plugins" });
      }
    },
    {
      id: "mcp",
      label: t("command.mcp"),
      detail: t("command.mcp.detail"),
      action: () => {
        input.closeFloatingSurfaces();
        input.navigate({ name: "settings", section: "mcp" });
      }
    },
    {
      id: "activity",
      label: t("command.activity"),
      detail: t("command.activity.detail"),
      action: () => {
        input.closeFloatingSurfaces();
        input.openActivity();
      }
    },
    {
      id: "web-search",
      label: t("command.webSearch"),
      detail: t("command.webSearch.detail"),
      action: () => {
        input.closeFloatingSurfaces();
        input.navigate({ name: "settings", section: "webSearch" });
      }
    },
    {
      id: "ui-catalog",
      label: "UI catalog",
      detail: "Inspect Jasmine design system primitives",
      action: () => {
        input.closeFloatingSurfaces();
        input.openUiCatalog();
      }
    },
    {
      id: "toggle-sidebar",
      label: t("command.toggleSidebar"),
      detail: input.sidebarCollapsed ? t("command.toggleSidebar.show") : t("command.toggleSidebar.hide"),
      action: input.toggleSidebar
    }
  ], [input, t]);
}
