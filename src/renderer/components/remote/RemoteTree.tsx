import { useMemo, useRef, useState } from "react";
import type {
  RemoteProfileStatus,
  RemoteProfileSummary,
  RemoteSessionSummary,
  RemoteWorkspace
} from "../../../shared/ipc";
import { useI18n } from "../../i18n";
import { ChevronRightIcon, EditIcon, MoreIcon, PlusIcon, RefreshIcon, ServerIcon, SettingsIcon, TrashIcon } from "../icons/Icons";
import { MenuItem, MenuSurface } from "../ui";
import type { RemoteHostGroup } from "../../hooks/useRemotes";

/** Rows shown under one workspace before the list defers to the full session view. */
const SESSIONS_PER_WORKSPACE = 5;

export type RemoteTreeProps = {
  hostGroups: RemoteHostGroup[];
  workspaces: RemoteWorkspace[];
  sessions: Record<string, RemoteSessionSummary[]>;
  statuses: Record<string, RemoteProfileStatus>;
  refreshingProfileIds: string[];
  activeProfileId: string | null;
  activeSessionId: string | null;
  onAddProfile(): void;
  onExpandProfile(profileId: string): void;
  onRefreshProfile(profileId: string): void;
  onOpenProfileSettings(profileId: string): void;
  onCheckProfile(profileId: string): void;
  onAddWorkspace(profileId: string): void;
  onRemoveWorkspace(workspace: RemoteWorkspace): void;
  onToggleWorkspacePinned(workspace: RemoteWorkspace): void;
  onOpenWorkspace(profileId: string, cwd: string): void;
  onOpenSession(profileId: string, sessionId: string): void;
};

export function RemoteTree(props: RemoteTreeProps) {
  const { t } = useI18n();
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(() => new Set());
  const [expandedProfiles, setExpandedProfiles] = useState<Set<string>>(() => new Set());
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set());
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const menuButtonRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  const workspacesByProfile = useMemo(() => groupBy(props.workspaces, (workspace) => workspace.profileId), [props.workspaces]);

  function toggle(setter: (updater: (current: Set<string>) => Set<string>) => void, id: string) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function bindMenuButton(id: string) {
    return (node: HTMLButtonElement | null) => {
      if (node) menuButtonRefs.current.set(id, node);
      else menuButtonRefs.current.delete(id);
    };
  }

  return (
    <div className="remote-tree">
      <div className="sidebar-section-heading">
        <span>{t("sidebar.remotes")}</span>
        <button type="button" aria-label={t("remote.addProfile")} title={t("remote.addProfile")} onClick={props.onAddProfile}>
          <PlusIcon />
        </button>
      </div>

      {props.hostGroups.length === 0 ? (
        <button className="sidebar-empty-action" type="button" onClick={props.onAddProfile}>
          <ServerIcon />
          <span>{t("remote.empty")}</span>
        </button>
      ) : props.hostGroups.map((group) => {
        const hostExpanded = expandedHosts.has(group.sshHost);
        return (
          <div className="remote-host-group" key={group.sshHost}>
            <div className={`remote-host-row ${hostExpanded ? "" : "collapsed"}`}>
              <button
                className="project-collapse"
                type="button"
                aria-expanded={hostExpanded}
                aria-label={hostExpanded ? t("remote.collapseHost", { host: group.sshHost }) : t("remote.expandHost", { host: group.sshHost })}
                title={hostExpanded ? t("remote.collapseHost", { host: group.sshHost }) : t("remote.expandHost", { host: group.sshHost })}
                onClick={() => toggle(setExpandedHosts, group.sshHost)}
              >
                <ChevronRightIcon />
              </button>
              <button className="remote-host-item" type="button" onClick={() => toggle(setExpandedHosts, group.sshHost)}>
                <ServerIcon />
                <span>{group.sshHost}</span>
                <small>{t("remote.hostProfiles", { count: group.profiles.length })}</small>
              </button>
            </div>
            {hostExpanded ? group.profiles.map((profile) => renderProfile(profile)) : null}
          </div>
        );
      })}
    </div>
  );

  function renderProfile(profile: RemoteProfileSummary) {
    const expanded = expandedProfiles.has(profile.id);
    const status = props.statuses[profile.id];
    const menuId = `profile:${profile.id}`;
    const menuOpen = menuOpenId === menuId;
    const profileWorkspaces = workspacesByProfile.get(profile.id) ?? [];
    const refreshing = props.refreshingProfileIds.includes(profile.id);
    return (
      <div className="remote-profile-group" key={profile.id}>
        <div className={`remote-profile-row ${props.activeProfileId === profile.id ? "active" : ""}`}>
          <button
            className="project-collapse"
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t("remote.collapseProfile", { name: profile.name }) : t("remote.expandProfile", { name: profile.name })}
            title={expanded ? t("remote.collapseProfile", { name: profile.name }) : t("remote.expandProfile", { name: profile.name })}
            onClick={() => {
              toggle(setExpandedProfiles, profile.id);
              if (!expanded) props.onExpandProfile(profile.id);
            }}
          >
            <ChevronRightIcon />
          </button>
          <button
            className="remote-profile-item"
            type="button"
            title={`${profile.name} · ${profile.sshHost}`}
            onClick={() => {
              if (!expanded) {
                toggle(setExpandedProfiles, profile.id);
                props.onExpandProfile(profile.id);
              }
            }}
          >
            <span className={`remote-status-dot ${statusTone(status)}`} aria-hidden="true" />
            {/* The name has to be here: two profiles on one host can share an
                egress mode, and then the egress label alone gives two identical
                rows for two isolated session histories. The tree column is
                narrow, so the egress keeps its short form and the descriptive
                one lives in Settings. */}
            <span>{profile.name}</span>
            <small>
              {profile.networkMode === "client-proxy" ? t("remote.egress.proxyShort") : t("remote.egress.directShort")}
              {" · "}
              {t(statusLabelKey(status))}
            </small>
          </button>
          <div className="thread-actions project-actions">
            <button
              ref={bindMenuButton(menuId)}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t("remote.profileActionsFor", { name: profile.name })}
              title={t("remote.profileActions")}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpenId((current) => current === menuId ? null : menuId);
              }}
            >
              <MoreIcon />
            </button>
            <button
              type="button"
              aria-label={t("remote.refreshSessions")}
              title={t("remote.refreshSessions")}
              disabled={refreshing}
              onClick={(event) => {
                event.stopPropagation();
                props.onRefreshProfile(profile.id);
              }}
            >
              <RefreshIcon />
            </button>
          </div>
          <MenuSurface
            anchorRef={{ current: menuButtonRefs.current.get(menuId) ?? null }}
            open={menuOpen}
            onOpenChange={(open) => {
              if (!open) setMenuOpenId((current) => current === menuId ? null : current);
            }}
            placement="right-start"
            minWidth={200}
            maxWidth={280}
            maxHeight={260}
            className="project-menu"
          >
            <MenuItem role="menuitem" leftIcon={<RefreshIcon />} onClick={() => {
              setMenuOpenId(null);
              props.onCheckProfile(profile.id);
            }}>
              {t("remote.checkConnection")}
            </MenuItem>
            <MenuItem role="menuitem" leftIcon={<PlusIcon />} onClick={() => {
              setMenuOpenId(null);
              props.onAddWorkspace(profile.id);
            }}>
              {t("remote.addWorkspace")}
            </MenuItem>
            <MenuItem role="menuitem" leftIcon={<SettingsIcon />} onClick={() => {
              setMenuOpenId(null);
              props.onOpenProfileSettings(profile.id);
            }}>
              {t("remote.openSettings")}
            </MenuItem>
          </MenuSurface>
        </div>
        {expanded ? (
          <>
            {profileWorkspaces.length === 0 ? (
              <div className="remote-empty-row">{t("remote.noWorkspaces")}</div>
            ) : profileWorkspaces.map((workspace) => renderWorkspace(profile, workspace))}
            <button className="remote-add-workspace" type="button" onClick={() => props.onAddWorkspace(profile.id)}>
              <PlusIcon />
              <span>{t("remote.addWorkspace")}</span>
            </button>
          </>
        ) : null}
      </div>
    );
  }

  function renderWorkspace(profile: RemoteProfileSummary, workspace: RemoteWorkspace) {
    const expanded = expandedWorkspaces.has(workspace.id);
    const menuId = `workspace:${workspace.id}`;
    const menuOpen = menuOpenId === menuId;
    const workspaceSessions = (props.sessions[profile.id] ?? []).filter((session) => session.cwd === workspace.cwd);
    return (
      <div className="remote-workspace-group" key={workspace.id}>
        <div className="remote-workspace-row">
          <button
            className="project-collapse"
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? t("remote.collapseWorkspace", { name: workspace.name }) : t("remote.expandWorkspace", { name: workspace.name })}
            title={expanded ? t("remote.collapseWorkspace", { name: workspace.name }) : t("remote.expandWorkspace", { name: workspace.name })}
            onClick={() => toggle(setExpandedWorkspaces, workspace.id)}
          >
            <ChevronRightIcon />
          </button>
          <button
            className="remote-workspace-item"
            type="button"
            title={workspace.cwd}
            onClick={() => props.onOpenWorkspace(profile.id, workspace.cwd)}
          >
            <span>{workspace.name}</span>
            <small>{workspace.sessionCount || t("sidebar.empty")}</small>
          </button>
          <div className="thread-actions project-actions">
            <button
              ref={bindMenuButton(menuId)}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t("remote.workspaceActionsFor", { name: workspace.name })}
              title={t("remote.profileActions")}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpenId((current) => current === menuId ? null : menuId);
              }}
            >
              <MoreIcon />
            </button>
          </div>
          <MenuSurface
            anchorRef={{ current: menuButtonRefs.current.get(menuId) ?? null }}
            open={menuOpen}
            onOpenChange={(open) => {
              if (!open) setMenuOpenId((current) => current === menuId ? null : current);
            }}
            placement="right-start"
            minWidth={180}
            maxWidth={260}
            maxHeight={220}
            className="project-menu"
          >
            <MenuItem role="menuitem" leftIcon={<EditIcon />} onClick={() => {
              setMenuOpenId(null);
              props.onToggleWorkspacePinned(workspace);
            }}>
              {workspace.pinned ? t("remote.workspace.unpin") : t("remote.workspace.pin")}
            </MenuItem>
            <MenuItem className="danger" role="menuitem" leftIcon={<TrashIcon />} aria-label={t("remote.workspace.remove", { name: workspace.name })} onClick={() => {
              setMenuOpenId(null);
              props.onRemoveWorkspace(workspace);
            }}>
              {t("app.delete")}
            </MenuItem>
          </MenuSurface>
        </div>
        {expanded ? (
          workspaceSessions.length === 0 ? (
            <div className="remote-empty-row nested">{t("remote.noSessions")}</div>
          ) : (
            <>
              {workspaceSessions.slice(0, SESSIONS_PER_WORKSPACE).map((session) => (
                <button
                  className={`remote-session-row ${props.activeSessionId === session.sessionId ? "active" : ""}`}
                  key={session.sessionId}
                  type="button"
                  aria-label={t("remote.session.open", { title: session.title })}
                  onClick={() => props.onOpenSession(profile.id, session.sessionId)}
                >
                  <span className={`remote-session-state ${session.state}`} aria-hidden="true" />
                  <span className="remote-session-title">{session.title}</span>
                  <small>{t(sessionStateKey(session.state))}</small>
                </button>
              ))}
              {workspaceSessions.length > SESSIONS_PER_WORKSPACE ? (
                <button
                  className="thread-list-more"
                  type="button"
                  onClick={() => props.onOpenWorkspace(profile.id, workspace.cwd)}
                >
                  {t("remote.showAllSessions", { count: workspaceSessions.length })}
                </button>
              ) : null}
            </>
          )
        ) : null}
      </div>
    );
  }
}

export function statusTone(status: RemoteProfileStatus | undefined): string {
  if (!status) return "unknown";
  if (status.state === "ready") return "ready";
  if (status.state === "needsSetup") return "attention";
  if (status.state === "failed") return "failed";
  if (status.state === "checking") return "checking";
  return "unknown";
}

export function statusLabelKey(status: RemoteProfileStatus | undefined) {
  return `remote.status.${status?.state ?? "unknown"}` as const;
}

export function sessionStateKey(state: RemoteSessionSummary["state"]) {
  return `remote.session.state.${state}` as const;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  }
  return groups;
}
