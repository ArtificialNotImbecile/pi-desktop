import type { ReactNode } from "react";
import type { ChatThread, WorkspaceProject } from "../../../shared/ipc";
import { SidebarIcon } from "../icons/Icons";
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

      {props.sidebarCollapsed && (
        <button className="sidebar-restore" type="button" onClick={stable.onToggleSidebar} aria-label={t("sidebar.show")} title={t("sidebar.show")}>
          <SidebarIcon />
        </button>
      )}

      {/* Title-bar chrome is shell-owned so every workspace route keeps window
          controls; see UI-FIXED-126. */}
      <div className="window-drag-region" aria-hidden="true" />
      <WindowControls />

      {props.children}
    </main>
  );
}
