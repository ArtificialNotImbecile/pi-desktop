import { memo, useMemo, useRef, useState } from "react";
import type { ChatThread, WorkspaceProject } from "../../../shared/ipc";
import { ChevronRightIcon, EditIcon, ExternalLinkIcon, FolderIcon, MoreIcon, PinIcon, PlusIcon, SearchIcon, SettingsIcon, SidebarIcon, TodoIcon, TrashIcon } from "../icons/Icons";
import { IconButton } from "../ui/IconButton";
import { MenuItem, MenuSurface } from "../ui";
import { useI18n } from "../../i18n";

declare global {
  interface Window {
    __JASMINE_HARNESS_ENABLED__?: boolean;
    __JASMINE_SIDEBAR_RENDERS__?: number;
  }
}

type RenameTarget =
  | { kind: "thread"; id: string }
  | { kind: "project"; id: string };

// Memoized so chat stream ticks (which re-render App/AppShell) do not reconcile
// the whole thread/project tree. AppShell passes identity-stable callbacks, so
// a shallow prop compare only fails when sidebar data actually changes.
export const Sidebar = memo(function Sidebar(props: {
  threads: ChatThread[];
  projects: WorkspaceProject[];
  activeThreadId: string | null;
  activeProjectId: string | null;
  todoActive: boolean;
  moreOpen: boolean;
  onToggleCollapsed(): void;
  onSearch(): void;
  onNewChat(): void;
  onNewChatInChats(): void;
  onNewChatInProject(projectId: string): void;
  onOpenProjectFolder(): void;
  onSelectProject(projectId: string): void;
  onSelectThread(threadId: string): void;
  onOpenTodo(): void;
  onToggleMore(): void;
  onClearHistory(): void;
  onOpenSettings(): void;
  onRenameThread(threadId: string, title: string): void;
  onDeleteThread(threadId: string): void;
  onRenameProject(projectId: string, name: string): void;
  onRemoveProject(projectId: string): void;
  onOpenProjectInExplorer(projectId: string): void;
  onCloseFloatingSurfaces(): void;
}) {
  recordHarnessRender();
  const { t } = useI18n();
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [visibleCount, setVisibleCount] = useState(60);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [projectMenuOpenId, setProjectMenuOpenId] = useState<string | null>(null);
  const [pinnedProjectIds, setPinnedProjectIds] = useState<Set<string>>(() => readPinnedProjectIds());
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const projectMenuButtonRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const threadsByProject = useMemo(() => groupThreadsByProject(props.threads), [props.threads]);
  const sortedProjects = useMemo(() => sortProjects(props.projects, pinnedProjectIds), [pinnedProjectIds, props.projects]);
  const chatThreads = threadsByProject.get(null) ?? [];

  function startThreadRename(thread: ChatThread) {
    setRenameTarget({ kind: "thread", id: thread.id });
    setRenameValue(thread.title);
  }

  function startProjectRename(project: WorkspaceProject) {
    setRenameTarget({ kind: "project", id: project.id });
    setRenameValue(project.name);
  }

  function submitRename(target: RenameTarget, currentTitle: string) {
    const title = renameValue.trim();
    if (!title || title === currentTitle) {
      setRenameTarget(null);
      return;
    }
    if (target.kind === "thread") props.onRenameThread(target.id, title);
    else props.onRenameProject(target.id, title);
    setRenameTarget(null);
  }

  function toggleProjectCollapsed(projectId: string) {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function bindProjectMenuButton(projectId: string) {
    return (node: HTMLButtonElement | null) => {
      if (node) projectMenuButtonRefs.current.set(projectId, node);
      else projectMenuButtonRefs.current.delete(projectId);
    };
  }

  function toggleProjectPinned(projectId: string) {
    setPinnedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      writePinnedProjectIds(next);
      return next;
    });
  }

  return (
    <aside className="sidebar">
      <div className="side-top">
        <IconButton label={t("sidebar.hide")} onClick={props.onToggleCollapsed}>
          <SidebarIcon />
        </IconButton>
        <IconButton label={t("sidebar.search")} onClick={() => {
          props.onCloseFloatingSurfaces();
          props.onSearch();
        }}>
          <SearchIcon />
        </IconButton>
        <IconButton label={t("sidebar.newChat")} onClick={() => {
          props.onCloseFloatingSurfaces();
          props.onNewChat();
        }}>
          <EditIcon />
        </IconButton>
      </div>

      <div className="sidebar-feature-list" aria-label={t("sidebar.features")}>
        <button
          className={`sidebar-feature-row ${props.todoActive ? "active" : ""}`}
          type="button"
          aria-current={props.todoActive ? "page" : undefined}
          onClick={() => {
            props.onCloseFloatingSurfaces();
            props.onOpenTodo();
          }}
        >
          <TodoIcon />
          <span>{t("sidebar.todo")}</span>
        </button>
      </div>

      <div className="thread-list">
        <div className="sidebar-section-heading">
          <span>{t("sidebar.projects")}</span>
          <button type="button" aria-label={t("sidebar.openFolder")} title={t("sidebar.openFolder")} onClick={props.onOpenProjectFolder}>
            <PlusIcon />
          </button>
        </div>
        {props.projects.length === 0 ? (
          <button className="sidebar-empty-action" type="button" onClick={props.onOpenProjectFolder}>
            <FolderIcon />
            <span>{t("sidebar.openFolder")}</span>
          </button>
        ) : sortedProjects.map((project) => {
          const projectThreads = threadsByProject.get(project.id) ?? [];
          const collapsed = collapsedProjects.has(project.id);
          const renameActive = renameTarget?.kind === "project" && renameTarget.id === project.id;
          const menuOpen = projectMenuOpenId === project.id;
          const menuAnchor = { current: projectMenuButtonRefs.current.get(project.id) ?? null };
          const pinned = pinnedProjectIds.has(project.id);
          return (
            <div className="project-group" key={project.id}>
              <div className={`project-row ${collapsed ? "collapsed" : ""}`}>
                {renameActive ? (
                  <RenameForm
                    label={t("sidebar.projectTitleFor", { title: project.name })}
                    value={renameValue}
                    onChange={setRenameValue}
                    onCancel={() => setRenameTarget(null)}
                    onSubmit={() => submitRename({ kind: "project", id: project.id }, project.name)}
                  />
                ) : (
                  <>
                    <button
                      className="project-collapse"
                      type="button"
                      aria-label={collapsed ? t("sidebar.expandProject", { title: project.name }) : t("sidebar.collapseProject", { title: project.name })}
                      title={collapsed ? t("sidebar.expandProject", { title: project.name }) : t("sidebar.collapseProject", { title: project.name })}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleProjectCollapsed(project.id);
                      }}
                    >
                      <ChevronRightIcon />
                    </button>
                    <button
                      className="project-item"
                      type="button"
                      title={project.rootPath}
                      onClick={() => props.onSelectProject(project.id)}
                    >
                      <FolderIcon />
                      <span>{project.name}</span>
                      <small>{projectThreads.length || t("sidebar.empty")}</small>
                    </button>
                    <div className="thread-actions project-actions" aria-label={t("sidebar.actionsFor", { title: project.name })}>
                      <button
                        ref={bindProjectMenuButton(project.id)}
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        aria-label={t("sidebar.projectActionsFor", { title: project.name })}
                        title={t("sidebar.projectActions")}
                        onClick={(event) => {
                          event.stopPropagation();
                          setProjectMenuOpenId((current) => current === project.id ? null : project.id);
                        }}
                      >
                        <MoreIcon />
                      </button>
                      <button
                        type="button"
                        aria-label={t("sidebar.newChatInProject", { title: project.name })}
                        title={t("sidebar.newChatInProject", { title: project.name })}
                        onClick={(event) => {
                          event.stopPropagation();
                          props.onCloseFloatingSurfaces();
                          props.onNewChatInProject(project.id);
                        }}
                      >
                        <EditIcon />
                      </button>
                    </div>
                    <MenuSurface
                      anchorRef={menuAnchor}
                      open={menuOpen}
                      onOpenChange={(open) => {
                        if (!open) setProjectMenuOpenId((current) => current === project.id ? null : current);
                      }}
                      placement="right-start"
                      minWidth={196}
                      maxWidth={260}
                      maxHeight={260}
                      className="project-menu"
                    >
                      <MenuItem role="menuitem" leftIcon={<PinIcon />} onClick={() => {
                        toggleProjectPinned(project.id);
                        setProjectMenuOpenId(null);
                      }}>
                        {pinned ? t("sidebar.unpinProject") : t("sidebar.pinProject")}
                      </MenuItem>
                      <MenuItem role="menuitem" leftIcon={<EditIcon />} aria-label={t("sidebar.renameProject", { title: project.name })} onClick={(event) => {
                        event.stopPropagation();
                        setProjectMenuOpenId(null);
                        startProjectRename(project);
                      }}>
                        {t("app.rename")}
                      </MenuItem>
                      <MenuItem role="menuitem" leftIcon={<ExternalLinkIcon />} onClick={(event) => {
                        event.stopPropagation();
                        setProjectMenuOpenId(null);
                        props.onOpenProjectInExplorer(project.id);
                      }}>
                        {t("sidebar.openProjectInExplorer")}
                      </MenuItem>
                      <MenuItem className="danger" role="menuitem" leftIcon={<TrashIcon />} aria-label={t("sidebar.removeProject", { title: project.name })} onClick={(event) => {
                        event.stopPropagation();
                        setProjectMenuOpenId(null);
                        props.onRemoveProject(project.id);
                      }}>
                        {t("app.delete")}
                      </MenuItem>
                    </MenuSurface>
                  </>
                )}
              </div>
              {!collapsed && projectThreads.slice(0, visibleCount).map((thread) => renderThreadRow(thread, true))}
            </div>
          );
        })}

        <div className="sidebar-section-heading chats-heading">
          <span>{t("sidebar.chats")}</span>
          <button type="button" aria-label={t("sidebar.newChatInChats")} title={t("sidebar.newChatInChats")} onClick={() => {
            props.onCloseFloatingSurfaces();
            props.onNewChatInChats();
          }}>
            <PlusIcon />
          </button>
        </div>
        {chatThreads.slice(0, visibleCount).map((thread) => renderThreadRow(thread, false))}
        {props.threads.length > visibleCount && (
          <button className="thread-list-more" type="button" onClick={() => setVisibleCount((count) => count + 50)}>
            {t("sidebar.showMoreChats")}
          </button>
        )}
      </div>

      <div className="side-footer">
        <IconButton ref={moreButtonRef} label={t("sidebar.more")} onClick={props.onToggleMore}>
          <MoreIcon />
        </IconButton>
        <MenuSurface
          anchorRef={moreButtonRef}
          open={props.moreOpen}
          onOpenChange={(open) => {
            if (!open && props.moreOpen) props.onToggleMore();
          }}
          placement="top-start"
          minWidth={180}
          maxWidth={240}
          maxHeight={180}
          className="side-menu"
        >
            <button type="button" onClick={() => {
              props.onCloseFloatingSurfaces();
              props.onOpenSettings();
            }}>
              <span className="menu-inline-icon"><SettingsIcon /></span>
              <span>{t("app.settings")}</span>
            </button>
            <button className="danger" type="button" onClick={props.onClearHistory}>
              <span className="menu-inline-icon"><TrashIcon /></span>
              <span>{t("sidebar.clearHistory")}</span>
            </button>
        </MenuSurface>
      </div>
    </aside>
  );

  function renderThreadRow(thread: ChatThread, nested: boolean) {
    const renameActive = renameTarget?.kind === "thread" && renameTarget.id === thread.id;
    return (
      <div className={`thread-row ${nested ? "nested" : ""} ${thread.id === props.activeThreadId ? "active" : ""}`} key={thread.id}>
        {renameActive ? (
          <RenameForm
            label={t("sidebar.threadTitleFor", { title: thread.title })}
            value={renameValue}
            onChange={setRenameValue}
            onCancel={() => setRenameTarget(null)}
            onSubmit={() => submitRename({ kind: "thread", id: thread.id }, thread.title)}
          />
        ) : (
          <>
            <button
              className="thread-item"
              onClick={() => props.onSelectThread(thread.id)}
              type="button"
            >
              <span>{thread.title}</span>
              <small>{thread.draft ? t("sidebar.draft") : thread.messageCount || t("sidebar.empty")}</small>
            </button>
            <div className="thread-actions" aria-label={t("sidebar.actionsFor", { title: thread.title })}>
              <button type="button" aria-label={t("sidebar.renameThread", { title: thread.title })} title={t("app.rename")} onClick={(event) => {
                event.stopPropagation();
                startThreadRename(thread);
              }}>
                <EditIcon />
              </button>
              <button className="danger" type="button" aria-label={t("sidebar.deleteThread", { title: thread.title })} title={t("app.delete")} onClick={(event) => {
                event.stopPropagation();
                props.onDeleteThread(thread.id);
              }}>
                <TrashIcon />
              </button>
            </div>
          </>
        )}
      </div>
    );
  }
});

function recordHarnessRender(): void {
  if (typeof window === "undefined" || !window.__JASMINE_HARNESS_ENABLED__) return;
  window.__JASMINE_SIDEBAR_RENDERS__ = (window.__JASMINE_SIDEBAR_RENDERS__ ?? 0) + 1;
}

function RenameForm(props: {
  label: string;
  value: string;
  onChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
}) {
  return (
    <form
      className="thread-rename-form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <input
        aria-label={props.label}
        autoFocus
        value={props.value}
        onBlur={props.onSubmit}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
      />
    </form>
  );
}

function groupThreadsByProject(threads: ChatThread[]): Map<string | null, ChatThread[]> {
  const grouped = new Map<string | null, ChatThread[]>();
  for (const thread of threads) {
    const key = thread.projectId ?? null;
    grouped.set(key, [...(grouped.get(key) ?? []), thread]);
  }
  return grouped;
}

const PINNED_PROJECTS_STORAGE_KEY = "jasmine.sidebar.pinnedProjects";

function readPinnedProjectIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(PINNED_PROJECTS_STORAGE_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : []);
  } catch {
    return new Set();
  }
}

function writePinnedProjectIds(ids: Set<string>) {
  try {
    window.localStorage.setItem(PINNED_PROJECTS_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // Pinning is a convenience affordance; failed local persistence should not block project actions.
  }
}

function sortProjects(projects: WorkspaceProject[], pinnedProjectIds: Set<string>): WorkspaceProject[] {
  return [...projects].sort((left, right) => {
    const leftPinned = pinnedProjectIds.has(left.id);
    const rightPinned = pinnedProjectIds.has(right.id);
    if (leftPinned === rightPinned) return 0;
    return leftPinned ? -1 : 1;
  });
}
