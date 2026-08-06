import { useMemo } from "react";
import type { ChatThread, WorkspaceProject } from "../../../shared/ipc";
import { CommandMenu, FadeScale, Presence, type CommandMenuItem } from "../ui";
import { useI18n } from "../../i18n";

export function SearchOverlay(props: {
  open: boolean;
  query: string;
  threads: ChatThread[];
  projects: WorkspaceProject[];
  onQueryChange(query: string): void;
  onClose(): void;
  onSelectThread(threadId: string): void;
}) {
  const { t } = useI18n();

  // Skip building the item list entirely while the overlay is closed; parent
  // re-renders (e.g. per stream tick) previously rebuilt it on every pass.
  const items: CommandMenuItem[] = useMemo(() => {
    if (!props.open) return [];
    const projectNames = new Map(props.projects.map((project) => [project.id, project.name]));
    return props.threads.map((thread) => ({
      id: thread.id,
      label: thread.title,
      description: `${thread.projectId ? projectNames.get(thread.projectId) ?? "Project" : t("sidebar.chats")} - ${t("search.messageCount", { count: thread.messageCount })}`,
      group: thread.projectId ? projectNames.get(thread.projectId) ?? t("sidebar.projects") : t("sidebar.chats"),
      keywords: [String(thread.messageCount), thread.projectId ? projectNames.get(thread.projectId) ?? "" : t("sidebar.chats")],
      trailing: <small>{thread.draft ? t("sidebar.draft") : thread.messageCount || t("sidebar.empty")}</small>,
      onSelect: () => {
        props.onSelectThread(thread.id);
        props.onClose();
      }
    }));
  }, [props.open, props.threads, props.projects, t]);

  return (
    <Presence>
      {props.open ? (
        <div className="search-backdrop" onMouseDown={props.onClose}>
          <FadeScale className="search-panel" onMouseDown={(event) => event.stopPropagation()}>
            <CommandMenu
              ariaLabel={t("sidebar.search")}
              className="search-command-menu"
              emptyClassName="search-empty"
              emptyLabel={t("search.empty")}
              inputAriaLabel={t("search.placeholder")}
              inputClassName="search-input"
              items={items}
              listClassName="search-results"
              placeholder={t("search.placeholder")}
              query={props.query}
              onQueryChange={props.onQueryChange}
              shortcut="Esc"
            />
          </FadeScale>
        </div>
      ) : null}
    </Presence>
  );
}
