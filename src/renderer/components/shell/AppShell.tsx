import type { ReactNode } from "react";
import type { ChatThread, WorkspaceProject } from "../../../shared/ipc";
import { EditIcon, SearchIcon, SidebarIcon } from "../icons/Icons";
import { IconButton } from "../ui/IconButton";
import { Sidebar } from "./Sidebar";
import { WindowControls } from "./WindowControls";
import { useI18n } from "../../i18n";
import { useStableCallbacks } from "../../hooks/useStableCallbacks";

export function AppShell(props: {
  children: ReactNode;
  threads: ChatThread[];
  projects: WorkspaceProject[];
  activeThreadId: string | null;
  activeProjectId: string | null;
  workingActive: boolean;
  workingActiveCount: number;
  workingAttention: boolean;
  messagesEmpty: boolean;
  sidebarCollapsed: boolean;
  moreOpen: boolean;
  onToggleSidebar(): void;
  onSearch(): void;
  onNewChat(): void;
  onNewChatInChats(): void;
  onNewChatInProject(projectId: string): void;
  onOpenProjectFolder(): void;
  onSelectProject(projectId: string): void;
  onSelectThread(threadId: string): void;
  onOpenWorking(): void;
  onToggleMore(): void;
  onOpenAbout(): void;
  onOpenSettings(): void;
  onRenameThread(threadId: string, title: string): void;
  onDeleteThread(threadId: string): void;
  onRenameProject(projectId: string, name: string): void;
  onRemoveProject(projectId: string): void;
  onOpenProjectInExplorer(projectId: string): void;
  onCloseFloatingSurfaces(): void;
}) {
  const { t } = useI18n();
  // App recreates these handler closures on every render (including each stream
  // tick); identity-stable wrappers keep the memoized Sidebar from reconciling.
  const stable = useStableCallbacks(props);
  return (
    <main className={`app-shell ${props.sidebarCollapsed ? "sidebar-collapsed" : ""} ${props.messagesEmpty ? "empty-active" : ""}`}>
      {/* Title-bar chrome is shell-owned so every workspace route keeps window
          controls; see UI-FIXED-126. It renders before every control that
          overlaps it because Electron builds the native draggable region by
          walking the layout tree in order, unioning `drag` rects and
          subtracting `no-drag` ones. A drag rect emitted after an overlapping
          no-drag rect covers that control back up and the OS swallows its
          clicks as window drags — which is exactly how the collapsed-sidebar
          restore control became unclickable on macOS. z-index does not save it:
          the region walk ignores paint order. */}
      <div className="window-drag-region" aria-hidden="true" />

      <Sidebar
        threads={props.threads}
        projects={props.projects}
        activeThreadId={props.activeThreadId}
        activeProjectId={props.activeProjectId}
        workingActive={props.workingActive}
        workingActiveCount={props.workingActiveCount}
        workingAttention={props.workingAttention}
        moreOpen={props.moreOpen}
        onToggleCollapsed={stable.onToggleSidebar}
        onSearch={stable.onSearch}
        onNewChat={stable.onNewChat}
        onNewChatInChats={stable.onNewChatInChats}
        onNewChatInProject={stable.onNewChatInProject}
        onOpenProjectFolder={stable.onOpenProjectFolder}
        onSelectProject={stable.onSelectProject}
        onSelectThread={stable.onSelectThread}
        onOpenWorking={stable.onOpenWorking}
        onToggleMore={stable.onToggleMore}
        onOpenAbout={stable.onOpenAbout}
        onOpenSettings={stable.onOpenSettings}
        onRenameThread={stable.onRenameThread}
        onDeleteThread={stable.onDeleteThread}
        onRenameProject={stable.onRenameProject}
        onRemoveProject={stable.onRemoveProject}
        onOpenProjectInExplorer={stable.onOpenProjectInExplorer}
        onCloseFloatingSurfaces={stable.onCloseFloatingSurfaces}
      />

      {/* Collapsing the rail used to leave one stray restore box in the corner
          and take Search and New chat away with it. The sidebar's top-row trio
          survives the collapse instead, in the same order, as title-bar chrome. */}
      {props.sidebarCollapsed && (
        <div className="sidebar-restore-bar" role="group" aria-label={t("sidebar.collapsedActions")}>
          <IconButton label={t("sidebar.show")} onClick={stable.onToggleSidebar}>
            <SidebarIcon />
          </IconButton>
          <IconButton label={t("sidebar.search")} onClick={() => {
            stable.onCloseFloatingSurfaces();
            stable.onSearch();
          }}>
            <SearchIcon />
          </IconButton>
          <IconButton label={t("sidebar.newChat")} onClick={() => {
            stable.onCloseFloatingSurfaces();
            stable.onNewChat();
          }}>
            <EditIcon />
          </IconButton>
        </div>
      )}

      <WindowControls />

      {props.children}
    </main>
  );
}
