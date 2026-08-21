import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RemoteDoctorReport,
  RemoteProfileCreateRequest,
  RemoteProfileStatus,
  RemoteProfileSummary,
  RemoteProfileUpdateRequest,
  RemoteSessionSummary,
  RemoteSessionStartResult,
  RemoteSessionTranscript,
  RemoteWorkspace,
  RemoteWorkspaceAddRequest
} from "../../shared/ipc";
import { getBridge } from "../desktopApi";
import { errorMessage } from "../utils/errors";

export type RemoteHostGroup = {
  sshHost: string;
  profiles: RemoteProfileSummary[];
};

/**
 * Sessions are kept per profile because that is the unit the host lists them in.
 * The map holds what SQLite already knows, so expanding a workspace renders from
 * memory and any refresh happens behind the rows already on screen.
 */
type SessionsByProfile = Record<string, RemoteSessionSummary[]>;

export function useRemotes(options: { onError(message: string): void; onToast(message: string): void }) {
  const [profiles, setProfiles] = useState<RemoteProfileSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([]);
  const [sessions, setSessions] = useState<SessionsByProfile>({});
  const [statuses, setStatuses] = useState<Record<string, RemoteProfileStatus>>({});
  const [refreshingProfileIds, setRefreshingProfileIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // Refresh is time-boxed per profile so expanding the same tree repeatedly does
  // not re-run an SSH round trip that just happened.
  const lastRefreshRef = useRef<Record<string, number>>({});
  const onErrorRef = useRef(options.onError);
  const onToastRef = useRef(options.onToast);
  onErrorRef.current = options.onError;
  onToastRef.current = options.onToast;

  const loadProfiles = useCallback(async () => {
    try {
      const [nextProfiles, nextWorkspaces, nextStatuses] = await Promise.all([
        getBridge().listRemoteProfiles(),
        getBridge().listRemoteWorkspaces(),
        getBridge().listRemoteProfileStatuses()
      ]);
      setProfiles(nextProfiles);
      setWorkspaces(nextWorkspaces);
      setStatuses(Object.fromEntries(nextStatuses.map((status) => [status.profileId, status])));
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to load remote profiles."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
    return getBridge().onRemoteStatusChanged((status) => {
      setStatuses((current) => ({ ...current, [status.profileId]: status }));
    });
  }, [loadProfiles]);

  const loadSessions = useCallback(async (profileId: string) => {
    try {
      const rows = await getBridge().listRemoteSessions({ profileId });
      setSessions((current) => ({ ...current, [profileId]: rows }));
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to read stored remote sessions."));
    }
  }, []);

  const refreshSessions = useCallback(async (profileId: string, options: { force?: boolean } = {}) => {
    const last = lastRefreshRef.current[profileId] ?? 0;
    if (!options.force && Date.now() - last < SESSION_REFRESH_WINDOW_MS) return;
    lastRefreshRef.current[profileId] = Date.now();
    setRefreshingProfileIds((current) => (current.includes(profileId) ? current : [...current, profileId]));
    try {
      const rows = await getBridge().refreshRemoteSessions({ profileId });
      setSessions((current) => ({ ...current, [profileId]: rows }));
      setWorkspaces(await getBridge().listRemoteWorkspaces());
    } catch (caught) {
      // A failed refresh must not blank the rows that came from SQLite.
      lastRefreshRef.current[profileId] = 0;
      onErrorRef.current(errorMessage(caught, "Failed to refresh remote sessions."));
    } finally {
      setRefreshingProfileIds((current) => current.filter((id) => id !== profileId));
    }
  }, []);

  /** Renders stored rows immediately, then reconciles with the host in the background. */
  const openProfile = useCallback(async (profileId: string) => {
    await loadSessions(profileId);
    void refreshSessions(profileId);
  }, [loadSessions, refreshSessions]);

  const createProfile = useCallback(async (request: RemoteProfileCreateRequest): Promise<RemoteProfileSummary | null> => {
    try {
      const profile = await getBridge().createRemoteProfile(request);
      await loadProfiles();
      onToastRef.current(`Added ${profile.name}`);
      return profile;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to add the remote profile."));
      return null;
    }
  }, [loadProfiles]);

  const updateProfile = useCallback(async (request: RemoteProfileUpdateRequest): Promise<RemoteProfileSummary | null> => {
    try {
      const profile = await getBridge().updateRemoteProfile(request);
      await loadProfiles();
      onToastRef.current("Remote profile saved");
      return profile;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to save the remote profile."));
      return null;
    }
  }, [loadProfiles]);

  const removeProfile = useCallback(async (profileId: string): Promise<boolean> => {
    try {
      await getBridge().removeRemoteProfile({ profileId });
      await loadProfiles();
      setSessions((current) => {
        const next = { ...current };
        delete next[profileId];
        return next;
      });
      onToastRef.current("Remote profile removed");
      return true;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to remove the remote profile."));
      return false;
    }
  }, [loadProfiles]);

  const checkProfile = useCallback(async (profileId: string): Promise<RemoteDoctorReport | null> => {
    try {
      return await getBridge().checkRemoteProfile({ profileId });
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "The connection check could not run."));
      return null;
    }
  }, []);

  const installRuntime = useCallback(async (profileId: string): Promise<boolean> => {
    try {
      const status = await getBridge().installRemoteRuntime({ profileId });
      if (status.state !== "ready") {
        onErrorRef.current(status.message ?? "Failed to install the remote runtime.");
        return false;
      }
      onToastRef.current("Remote runtime installed");
      return true;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to install the remote runtime."));
      return false;
    }
  }, []);

  const stopProfile = useCallback(async (profileId: string): Promise<boolean> => {
    try {
      // A failed stop resolves with a failed status rather than rejecting, so
      // the returned state decides whether anything actually stopped.
      const status = await getBridge().stopRemoteProfile({ profileId });
      if (status.state !== "disconnected") {
        onErrorRef.current(status.message ?? "Failed to stop the remote runtime.");
        return false;
      }
      onToastRef.current("Remote runtime stopped");
      return true;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to stop the remote runtime."));
      return false;
    }
  }, []);

  const addWorkspace = useCallback(async (request: RemoteWorkspaceAddRequest): Promise<RemoteWorkspace | null> => {
    try {
      const workspace = await getBridge().addRemoteWorkspace(request);
      const [nextWorkspaces, nextProfiles] = await Promise.all([
        getBridge().listRemoteWorkspaces(),
        getBridge().listRemoteProfiles()
      ]);
      setWorkspaces(nextWorkspaces);
      setProfiles(nextProfiles);
      onToastRef.current(`Added ${workspace.name}`);
      return workspace;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to add the workspace."));
      return null;
    }
  }, []);

  const updateWorkspace = useCallback(async (id: string, patch: { name?: string; pinned?: boolean }): Promise<boolean> => {
    try {
      await getBridge().updateRemoteWorkspace({ id, ...patch });
      setWorkspaces(await getBridge().listRemoteWorkspaces());
      return true;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to update the workspace."));
      return false;
    }
  }, []);

  const removeWorkspace = useCallback(async (id: string): Promise<boolean> => {
    try {
      await getBridge().removeRemoteWorkspace({ id });
      setWorkspaces(await getBridge().listRemoteWorkspaces());
      onToastRef.current("Workspace removed");
      return true;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to remove the workspace."));
      return false;
    }
  }, []);

  const openSession = useCallback(async (
    profileId: string,
    sessionId: string,
    openOptions: { refetch?: boolean } = {}
  ): Promise<RemoteSessionTranscript | null> => {
    try {
      const transcript = await getBridge().openRemoteSession({ profileId, sessionId, ...openOptions });
      // The row's cache state changed as a side effect of opening it.
      await loadSessions(profileId);
      return transcript;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to open the remote session."));
      return null;
    }
  }, [loadSessions]);

  const startSession = useCallback(async (profileId: string, cwd: string, text: string): Promise<RemoteSessionStartResult | null> => {
    try {
      const result = await getBridge().startRemoteSession({ profileId, cwd, text });
      lastRefreshRef.current[profileId] = Date.now();
      setSessions((current) => ({
        ...current,
        [profileId]: upsertSession(current[profileId] ?? [], result.session)
      }));
      setWorkspaces(await getBridge().listRemoteWorkspaces());
      onToastRef.current("Remote session created");
      return result;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to create the remote session."));
      return null;
    }
  }, []);

  const promptSession = useCallback(async (
    profileId: string,
    sessionId: string,
    text: string
  ): Promise<RemoteSessionTranscript | null> => {
    try {
      const transcript = await getBridge().promptRemoteSession({ profileId, sessionId, text });
      lastRefreshRef.current[profileId] = Date.now();
      await Promise.all([
        loadSessions(profileId),
        getBridge().listRemoteWorkspaces().then(setWorkspaces)
      ]);
      return transcript;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "The remote prompt failed."));
      return null;
    }
  }, [loadSessions]);

  const abortSession = useCallback(async (profileId: string, sessionId?: string): Promise<boolean> => {
    try {
      const aborted = await getBridge().abortRemoteSession({ profileId, ...(sessionId ? { sessionId } : {}) });
      if (!aborted) onErrorRef.current("The remote session is no longer running.");
      return aborted;
    } catch (caught) {
      onErrorRef.current(errorMessage(caught, "Failed to stop the remote response."));
      return false;
    }
  }, []);

  const hostGroups = useMemo<RemoteHostGroup[]>(() => groupProfilesByHost(profiles), [profiles]);

  return {
    profiles,
    hostGroups,
    workspaces,
    sessions,
    statuses,
    refreshingProfileIds,
    loadingRemotes: loading,
    refreshRemotes: loadProfiles,
    openProfile,
    loadSessions,
    refreshSessions,
    createProfile,
    updateProfile,
    removeProfile,
    checkProfile,
    installRuntime,
    stopProfile,
    addWorkspace,
    updateWorkspace,
    removeWorkspace,
    openSession,
    startSession,
    promptSession,
    abortSession
  };
}

export const SESSION_REFRESH_WINDOW_MS = 60_000;

export function groupProfilesByHost(profiles: RemoteProfileSummary[]): RemoteHostGroup[] {
  const groups = new Map<string, RemoteProfileSummary[]>();
  for (const profile of profiles) {
    groups.set(profile.sshHost, [...(groups.get(profile.sshHost) ?? []), profile]);
  }
  return [...groups.entries()]
    .map(([sshHost, hostProfiles]) => ({ sshHost, profiles: hostProfiles }))
    .sort((left, right) => left.sshHost.localeCompare(right.sshHost));
}

function upsertSession(rows: RemoteSessionSummary[], next: RemoteSessionSummary): RemoteSessionSummary[] {
  const index = rows.findIndex((row) => row.sessionId === next.sessionId);
  if (index < 0) return [next, ...rows];
  return rows.map((row, rowIndex) => rowIndex === index ? next : row);
}
