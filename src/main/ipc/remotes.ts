import { ipcMain } from "electron";
import type {
  RemoteDirectoryListRequest,
  RemoteDirectoryListing,
  RemoteDoctorReport,
  RemoteProfileCreateRequest,
  RemoteProfileIdRequest,
  RemoteProfileStatus,
  RemoteProfileSummary,
  RemoteProfileUpdateRequest,
  RemoteSessionListRequest,
  RemoteSessionOpenRequest,
  RemoteSessionStartRequest,
  RemoteSessionStartResult,
  RemoteSessionSubmissionPending,
  RemoteSessionPromptRequest,
  RemoteSessionAbortRequest,
  RemoteSessionSummary,
  RemoteSessionTranscript,
  RemoteWorkspace,
  RemoteWorkspaceAddRequest,
  RemoteWorkspaceIdRequest,
  RemoteWorkspaceUpdateRequest
} from "../../shared/ipc.js";
import {
  remoteDirectoryListSchema,
  remoteProfileCreateSchema,
  remoteProfileIdSchema,
  remoteProfileUpdateSchema,
  remoteSessionListSchema,
  remoteSessionOpenSchema,
  remoteSessionStartSchema,
  remoteSessionPromptSchema,
  remoteSessionAbortSchema,
  remoteWorkspaceAddSchema,
  remoteWorkspaceIdSchema,
  remoteWorkspaceUpdateSchema
} from "../../shared/schemas.js";
import { getRemoteProfileService } from "../services/remoteProfiles.js";
import type { IpcContext } from "./context.js";

export function registerRemoteIpc(context: IpcContext): void {
  const service = () => getRemoteProfileService(context.getDatabase());

  ipcMain.handle("remotes:listProfiles", (): Promise<RemoteProfileSummary[]> => service().listProfiles());

  ipcMain.handle("remotes:createProfile", (_event, request: RemoteProfileCreateRequest): Promise<RemoteProfileSummary> => {
    return service().createProfile(remoteProfileCreateSchema.parse(request));
  });

  ipcMain.handle("remotes:updateProfile", (_event, request: RemoteProfileUpdateRequest): Promise<RemoteProfileSummary> => {
    return service().updateProfile(remoteProfileUpdateSchema.parse(request));
  });

  ipcMain.handle("remotes:removeProfile", (_event, request: RemoteProfileIdRequest): Promise<void> => {
    return service().removeProfile(remoteProfileIdSchema.parse(request).profileId);
  });

  ipcMain.handle("remotes:checkProfile", (_event, request: RemoteProfileIdRequest): Promise<RemoteDoctorReport> => {
    return service().checkProfile(remoteProfileIdSchema.parse(request).profileId);
  });

  ipcMain.handle("remotes:installRuntime", (_event, request: RemoteProfileIdRequest): Promise<RemoteProfileStatus> => {
    return service().installRuntime(remoteProfileIdSchema.parse(request).profileId);
  });

  ipcMain.handle("remotes:stopProfile", (_event, request: RemoteProfileIdRequest): Promise<RemoteProfileStatus> => {
    return service().stopProfile(remoteProfileIdSchema.parse(request).profileId);
  });

  ipcMain.handle("remotes:listStatuses", (): RemoteProfileStatus[] => service().listStatuses());

  ipcMain.handle("remotes:listWorkspaces", (_event, request?: Partial<RemoteProfileIdRequest>): Promise<RemoteWorkspace[]> => {
    const profileId = request?.profileId ? remoteProfileIdSchema.parse(request).profileId : undefined;
    return service().listWorkspaces(profileId);
  });

  ipcMain.handle("remotes:addWorkspace", (_event, request: RemoteWorkspaceAddRequest): Promise<RemoteWorkspace> => {
    return service().addWorkspace(remoteWorkspaceAddSchema.parse(request));
  });

  ipcMain.handle("remotes:updateWorkspace", (_event, request: RemoteWorkspaceUpdateRequest): Promise<RemoteWorkspace> => {
    return service().updateWorkspace(remoteWorkspaceUpdateSchema.parse(request));
  });

  ipcMain.handle("remotes:removeWorkspace", (_event, request: RemoteWorkspaceIdRequest): void => {
    service().removeWorkspace(remoteWorkspaceIdSchema.parse(request).id);
  });

  ipcMain.handle("remotes:listDirectory", (_event, request: RemoteDirectoryListRequest): Promise<RemoteDirectoryListing> => {
    const parsed = remoteDirectoryListSchema.parse(request);
    return service().listDirectory(parsed.profileId, parsed.path);
  });

  ipcMain.handle("remotes:listSessions", (_event, request: RemoteSessionListRequest): RemoteSessionSummary[] => {
    const parsed = remoteSessionListSchema.parse(request);
    return service().listSessions(parsed.profileId, parsed.cwd);
  });

  ipcMain.handle("remotes:refreshSessions", (_event, request: RemoteProfileIdRequest): Promise<RemoteSessionSummary[]> => {
    return service().refreshSessions(remoteProfileIdSchema.parse(request).profileId);
  });

  ipcMain.handle("remotes:openSession", (_event, request: RemoteSessionOpenRequest): Promise<RemoteSessionTranscript> => {
    const parsed = remoteSessionOpenSchema.parse(request);
    return service().openSession(parsed.profileId, parsed.sessionId, parsed.refetch ?? false);
  });

  ipcMain.handle("remotes:startSession", (_event, request: RemoteSessionStartRequest): Promise<RemoteSessionStartResult | RemoteSessionSubmissionPending> => {
    const parsed = remoteSessionStartSchema.parse(request);
    return service().startSession(parsed.profileId, parsed.cwd, parsed.text);
  });

  ipcMain.handle("remotes:promptSession", (_event, request: RemoteSessionPromptRequest): Promise<RemoteSessionTranscript | RemoteSessionSubmissionPending> => {
    const parsed = remoteSessionPromptSchema.parse(request);
    return service().promptSession(parsed.profileId, parsed.sessionId, parsed.text);
  });

  ipcMain.handle("remotes:abortSession", (_event, request: RemoteSessionAbortRequest): Promise<boolean> => {
    const parsed = remoteSessionAbortSchema.parse(request);
    return service().abortSession(parsed.profileId, parsed.sessionId);
  });
}
