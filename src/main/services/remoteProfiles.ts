import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type {
  RemoteDirectoryEntry,
  RemoteDirectoryListing,
  RemoteDoctorReport,
  RemoteProfileCreateRequest,
  RemoteProfileStatus,
  RemoteProfileSummary,
  RemoteProfileUpdateRequest,
  RemoteSessionSummary,
  RemoteSessionStartResult,
  RemoteSessionSubmissionPending,
  RemoteSessionTranscript,
  RemoteTranscriptEntry,
  RemoteWorkspace,
  RemoteWorkspaceAddRequest,
  RemoteWorkspaceUpdateRequest
} from "../../shared/ipc.js";
import type { JasmineDatabase } from "../db/database.js";
import type { RemoteSessionRecord } from "../db/repositories/remotes.js";
import {
  joinRemotePath,
  normalizeRemotePath,
  parentRemotePath,
  readTranscriptEntries,
  resolveSessionSyncPlan,
  syncSessionFile
} from "./remoteTranscript.js";
import { isDefinitePromptRejection, isDetachedPromptFailure, promptManagedRemoteSession, startManagedRemoteSession } from "./remoteSessionRun.js";
// Imported module by module rather than through the package barrel: the barrel
// also exports the upstream compatibility baseline, whose only purpose is
// development-time protocol tests and whose `@earendil-works/pi-protocol` import
// is a devDependency of that package alone. Loading the barrel from the app
// would fail at startup with a module-not-found for a package the app does not
// ship and does not need.
import { PiRemoteError } from "../agent/extensions/piRemote/errors.js";
import { ProfileStore } from "../agent/extensions/piRemote/profiles.js";
import { ManagedRemoteRuntime } from "../agent/extensions/piRemote/runtime.js";
import { shellQuote } from "../agent/extensions/piRemote/ssh.js";
import type {
  RemoteProfile,
  RemoteSessionMetadata,
  RemoteSessionPort,
  RuntimeInfo
} from "../agent/extensions/piRemote/types.js";

/** Entries rendered for one session. Older ones are summarized rather than mounted. */
const TRANSCRIPT_ENTRY_LIMIT = 400;
const DIRECTORY_ENTRY_LIMIT = 300;
/** One incremental read; a larger gap loops until it reaches the end. */
const SESSION_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_SESSION_SYNC_BYTES = 64 * 1024 * 1024;
const DETACHED_OPERATION_POLL_MS = 5_000;
const STARTUP_RECOVERY_ATTEMPTS = 3;

type ActiveRemoteOperation = {
  sessionId: string | null;
  cwd: string;
  port: RemoteSessionPort | null;
  abortRequested: boolean;
  phase: "opening" | "attached" | "detached";
  state: "running" | "reconnecting" | "stopping";
  promptAccepted: boolean;
  detachedEgress: { close(): Promise<void> } | null;
  monitoring: boolean;
  done: Promise<void>;
  resolveDone(): void;
};

export class RemoteProfileService {
  private readonly store: ProfileStore;
  private readonly runtime: ManagedRemoteRuntime;
  private readonly statuses = new Map<string, RemoteProfileStatus>();
  private readonly activeOperations = new Map<string, ActiveRemoteOperation>();
  private readonly cancelledStartupRecovery = new Set<string>();
  private readonly startupRecoveryByProfile = new Map<string, Promise<void>>();
  private readonly transcriptRoot: string;
  private readonly startupRecovery: Promise<void>;

  constructor(
    private readonly db: JasmineDatabase,
    options: { store?: ProfileStore; runtime?: ManagedRemoteRuntime; transcriptRoot?: string } = {}
  ) {
    this.store = options.store ?? new ProfileStore();
    this.runtime = options.runtime ?? new ManagedRemoteRuntime({ artifactDirectory: resolveArtifactDirectory() });
    this.transcriptRoot = options.transcriptRoot ?? path.join(app.getPath("userData"), "remote-sessions");
    // Recovery starts with the service, not with navigation. A client-proxy
    // prompt loses its local egress when the old Jasmine process exits, so
    // waiting for the user to expand its profile can already be too late.
    this.startupRecovery = this.recoverActiveOperationsOnStartup();
  }

  async listProfiles(): Promise<RemoteProfileSummary[]> {
    const profiles = await this.store.list();
    return profiles.map(toProfileSummary).sort((left, right) =>
      left.sshHost.localeCompare(right.sshHost) || left.name.localeCompare(right.name));
  }

  async createProfile(request: RemoteProfileCreateRequest): Promise<RemoteProfileSummary> {
    // The directory is a workspace key, and the host reports its own canonical
    // spelling for every session. Storing "/srv/app/" as typed would make the
    // first reconciliation discover "/srv/app" as a second, duplicate workspace.
    const defaultCwd = request.defaultCwd ? normalizeRemotePath(request.defaultCwd) : null;
    const profile = await this.store.add({
      name: request.name,
      sshHost: request.sshHost,
      ...(request.sshPort ? { sshPort: request.sshPort } : {}),
      ...(defaultCwd ? { defaultCwd } : {}),
      networkMode: request.networkMode,
      ...(request.noProxy ? { noProxy: request.noProxy } : {}),
      ...(request.allowedPorts ? { allowedPorts: request.allowedPorts } : {}),
      ...(request.upstreamProxyEnv ? { upstreamProxyEnv: request.upstreamProxyEnv } : {})
    });
    // A profile with a default directory already has one workspace worth showing,
    // before any session exists to discover one from.
    if (profile.defaultCwd) {
      this.db.upsertRemoteWorkspace({ profileId: profile.id, cwd: profile.defaultCwd, source: "manual" });
    }
    this.publishStatus({ profileId: profile.id, state: "unknown" });
    return toProfileSummary(profile);
  }

  async updateProfile(request: RemoteProfileUpdateRequest): Promise<RemoteProfileSummary> {
    const { profileId, ...patch } = request;
    const profile = await this.store.update(profileId, {
      ...patch,
      ...(patch.defaultCwd ? { defaultCwd: normalizeRemotePath(patch.defaultCwd) } : {})
    });
    if (profile.defaultCwd) {
      this.db.upsertRemoteWorkspace({ profileId: profile.id, cwd: profile.defaultCwd, source: "manual" });
    }
    return toProfileSummary(profile);
  }

  /**
   * Removes local connection details and the local transcript copies. Remote
   * sessions, credentials, and the installed runtime are left alone -- the UI
   * says so, and this is what makes that promise true.
  */
  async removeProfile(profileId: string): Promise<void> {
    await this.awaitProfileStartupRecovery(profileId);
    this.cancelledStartupRecovery.add(profileId);
    let removed = false;
    try {
      if (this.activeOperations.has(profileId)) {
        throw new PiRemoteError(
          "remote-profile-busy",
          "The remote profile has an active session operation.",
          { phase: "session", retryable: true, remediation: "Wait for it to finish or stop the remote runtime first." }
        );
      }
      const profile = await this.store.get(profileId);
      // profiles.json goes first. If that write fails the profile is still
      // configured and the renderer keeps showing it, so deleting its history
      // beforehand would destroy data for a profile the user still has.
      await this.store.remove(profile.id);
      removed = true;
      const transcripts = this.db.removeRemoteProfileData(profile.id);
      await Promise.all(transcripts.map((file) => rm(file, { force: true }).catch(() => {})));
      await rm(path.join(this.transcriptRoot, profile.id), { recursive: true, force: true }).catch(() => {});
      this.statuses.delete(profile.id);
    } finally {
      if (!removed) this.cancelledStartupRecovery.delete(profileId);
    }
  }

  async checkProfile(profileId: string): Promise<RemoteDoctorReport> {
    const profile = await this.store.get(profileId);
    this.publishStatus({ profileId: profile.id, state: "checking", busy: true });
    try {
      const report = await this.runtime.doctor(profile);
      const checkedAt = new Date().toISOString();
      // doctor only checks that this machine has the artifact to send, never
      // whether the host already has it unpacked. Without probing that, a host
      // that is reachable but has no runtime would report Connected here and
      // then flip to Runtime not installed on the first session refresh.
      const installed = report.ok ? await this.probeRuntime(profile) : null;
      const runtimeMissing = report.checks.some((check) => check.id === "artifact" && check.status === "fail")
        || (report.ok && !installed);
      this.publishStatus({
        profileId: profile.id,
        state: report.ok && installed ? "ready" : runtimeMissing ? "needsSetup" : "failed",
        message: report.ok ? null : firstFailure(report.checks),
        errorCode: null,
        remediation: null,
        ...(installed ? { runtimeVersion: installed.runtimeVersion, piVersion: installed.piVersion } : {}),
        checkedAt,
        busy: false
      });
      return {
        profileId: profile.id,
        ok: report.ok && Boolean(installed),
        checks: [
          ...report.checks.map((check) => ({ id: check.id, status: check.status, message: check.message })),
          ...(report.ok ? [{
            id: "remote-runtime",
            status: installed ? "pass" as const : "fail" as const,
            message: installed
              ? `Managed runtime ${installed.runtimeVersion} (Pi ${installed.piVersion}) is installed on this host.`
              : "The managed runtime is not installed on this host yet."
          }] : [])
        ],
        checkedAt
      };
    } catch (error) {
      this.publishFailure(profile.id, error);
      throw error;
    }
  }

  /**
   * Answers whether the host already has the runtime, without installing one.
   * Only an answered "not installed" becomes null: swallowing the rest would
   * turn an unreachable host or malformed lifecycle output into "install the
   * runtime", which is not the remediation that fixes it.
   */
  private async probeRuntime(profile: RemoteProfile): Promise<RuntimeInfo | null> {
    try {
      return await this.runtime.requireRuntime(profile);
    } catch (error) {
      if (error instanceof PiRemoteError && error.code === "runtime-not-installed") return null;
      throw error;
    }
  }

  async installRuntime(profileId: string): Promise<RemoteProfileStatus> {
    const profile = await this.store.get(profileId);
    this.publishStatus({ profileId: profile.id, state: "checking", busy: true });
    try {
      const info = await this.runtime.ensureRuntime(profile);
      return this.publishStatus({
        profileId: profile.id,
        state: "ready",
        message: null,
        errorCode: null,
        remediation: null,
        runtimeVersion: info.runtimeVersion,
        piVersion: info.piVersion,
        checkedAt: new Date().toISOString(),
        busy: false
      });
    } catch (error) {
      return this.publishFailure(profile.id, error);
    }
  }

  /**
   * Ends the remote daemon and any session it owns. Distinct from losing the
   * connection, which leaves remote work running.
   */
  async stopProfile(profileId: string): Promise<RemoteProfileStatus> {
    await this.awaitProfileStartupRecovery(profileId);
    const profile = await this.store.get(profileId);
    this.publishStatus({ profileId: profile.id, state: "checking", busy: true });
    try {
      const active = this.activeOperations.get(profile.id);
      if (active) {
        const stopped = await this.abortSession(profile.id, active.sessionId ?? undefined);
        if (!stopped) throw new PiRemoteError("remote-stop-failed", "The active remote session could not be stopped.", { phase: "session", retryable: true });
        await active.done;
      }
      await this.runtime.stop(profile);
      return this.publishStatus({ profileId: profile.id, state: "disconnected", message: null, busy: false });
    } catch (error) {
      return this.publishFailure(profile.id, error);
    }
  }

  listStatuses(): RemoteProfileStatus[] {
    return [...this.statuses.values()];
  }

  async listWorkspaces(profileId?: string): Promise<RemoteWorkspace[]> {
    const profiles = await this.store.list();
    // profiles.json can also be written by the pi-remote CLI, so the stored
    // spelling is compared in the same normalized form the workspaces use.
    const defaultCwdByProfile = new Map(profiles.map((profile) =>
      [profile.id, profile.defaultCwd ? normalizeRemotePath(profile.defaultCwd) : null]));
    // profiles.json is the owner of the profile list, so a workspace whose
    // profile is gone is stale local state rather than something to display.
    return this.db.listRemoteWorkspaces(profileId)
      .filter((workspace) => defaultCwdByProfile.has(workspace.profileId))
      .map((workspace) => ({
        ...workspace,
        isDefaultCwd: defaultCwdByProfile.get(workspace.profileId) === workspace.cwd
      }));
  }

  async addWorkspace(request: RemoteWorkspaceAddRequest): Promise<RemoteWorkspace> {
    const profile = await this.store.get(request.profileId);
    const cwd = normalizeRemotePath(request.cwd);
    const workspace = this.db.upsertRemoteWorkspace({
      profileId: profile.id,
      cwd,
      ...(request.name ? { name: request.name } : {}),
      source: "manual"
    });
    if (request.setDefault) await this.store.update(profile.id, { defaultCwd: cwd });
    const [resolved] = await this.listWorkspaces(profile.id).then((all) => all.filter((item) => item.id === workspace.id));
    return resolved ?? workspace;
  }

  async updateWorkspace(request: RemoteWorkspaceUpdateRequest): Promise<RemoteWorkspace> {
    const updated = this.db.updateRemoteWorkspace(request);
    const [resolved] = await this.listWorkspaces(updated.profileId).then((all) => all.filter((item) => item.id === updated.id));
    return resolved ?? updated;
  }

  removeWorkspace(id: string): void {
    this.db.removeRemoteWorkspace(id);
  }

  /** Local only. Never touches the network, so opening a workspace is instant. */
  listSessions(profileId: string, cwd?: string): RemoteSessionSummary[] {
    return this.db.listRemoteSessions(profileId, cwd).map(toSessionSummary);
  }

  /**
   * Asks the host what it has and reconciles it with what is stored. Sessions the
   * listing no longer reports keep their local copy and are marked gone; new
   * working directories become discovered workspaces.
   *
   * This runs from an ordinary tree expansion, so it never installs the managed
   * runtime: a host without one reports that it needs setup and keeps whatever
   * rows are already stored, leaving the ~83 MB upload to the explicit action.
   */
  async refreshSessions(profileId: string): Promise<RemoteSessionSummary[]> {
    const profile = await this.store.get(profileId);
    let sessions: RemoteSessionMetadata[];
    let runtimeInfo: RuntimeInfo;
    try {
      const snapshot = await this.runtime.listSessionsWithRuntime(profile, { install: false });
      sessions = snapshot.sessions;
      runtimeInfo = snapshot.runtimeInfo;
    } catch (error) {
      if (error instanceof PiRemoteError && error.code === "runtime-not-installed") {
        this.publishStatus({
          profileId: profile.id,
          state: "needsSetup",
          message: error.message,
          errorCode: error.code,
          remediation: error.remediation ?? null,
          checkedAt: new Date().toISOString(),
          busy: false
        });
        return this.listSessions(profile.id);
      }
      this.publishFailure(profile.id, error);
      throw error;
    }
    this.db.replaceRemoteSessionListing(profile.id, sessions.map((session) => ({
      profileId: profile.id,
      sessionId: session.id,
      // Same normalization the workspaces are keyed by, so a session and the
      // directory it belongs to cannot end up as two different strings. A
      // session with no cwd stays empty rather than becoming the root.
      cwd: session.cwd ? normalizeRemotePath(session.cwd) : "",
      name: session.name ?? null,
      preview: session.preview ?? null,
      turnCount: session.turnCount ?? null,
      remoteCreatedAt: session.createdAt,
      remoteUpdatedAt: session.updatedAt ?? null,
      remoteSizeBytes: session.sizeBytes ?? null,
      headerFingerprint: session.headerFingerprint ?? null
    })));
    // Directories the host still has sessions in are workspaces; ones it no
    // longer does lose the workspace that only existed because of them, unless
    // the user added that directory by hand.
    const cwds = this.db.listRemoteSessionCwds(profile.id);
    for (const cwd of cwds) {
      this.db.upsertRemoteWorkspace({ profileId: profile.id, cwd, source: "discovered" });
    }
    this.db.pruneDiscoveredRemoteWorkspaces(profile.id, cwds);
    this.publishStatus({
      profileId: profile.id,
      state: "ready",
      message: null,
      errorCode: null,
      remediation: null,
      checkedAt: new Date().toISOString(),
      busy: false
    });
    this.recoverActiveOperation(profile, runtimeInfo);
    return this.listSessions(profile.id);
  }

  /** Creates the session and runs its first prompt on one RPC port, then publishes the durable result. */
  async startSession(profileId: string, cwd: string, text: string): Promise<RemoteSessionStartResult | RemoteSessionSubmissionPending> {
    await this.awaitProfileStartupRecovery(profileId);
    const profile = await this.store.get(profileId);
    const normalizedCwd = normalizeRemotePath(cwd);
    const operation = this.reserveOperation(profile.id, null, normalizedCwd);
    let detached = false;
    try {
      operation.sessionId = await startManagedRemoteSession(
        this.runtime,
        profile,
        normalizedCwd,
        text,
        {
          onPort: async (port) => {
            operation.port = port;
            operation.phase = "attached";
            this.updateOperationStatus(profile.id, operation, "running");
            if (operation.abortRequested) {
              await port.abort().catch(() => {});
              throw new PiRemoteError("remote-prompt-aborted", "The remote prompt was stopped before it started.", { phase: "session" });
            }
          },
          onSessionId: async (sessionId, port) => {
            operation.sessionId = sessionId;
            this.updateOperationStatus(profile.id, operation, "running");
            if (operation.abortRequested) {
              await port.abort().catch(() => {});
              throw new PiRemoteError("remote-prompt-aborted", "The remote prompt was stopped before it started.", { phase: "session" });
            }
          },
          onPromptAccepted: () => {
            operation.promptAccepted = true;
          }
        }
      );
      operation.port = null;
      const rows = await this.refreshSessions(profile.id);
      const created = rows.find((row) => row.sessionId === operation.sessionId);
      if (!created) {
        throw new PiRemoteError(
          "remote-session-not-listed",
          "The remote session was created but did not appear in the host's session listing.",
          { phase: "session", retryable: true, remediation: "Refresh the session list and open the new session." }
        );
      }
      const transcript = await this.openSession(profile.id, created.sessionId, true);
      return { session: created, transcript };
    } catch (error) {
      if (isDetachedPromptFailure(error)) {
        detached = true;
        operation.phase = "detached";
        this.updateOperationStatus(profile.id, operation, "reconnecting");
        this.monitorDetachedOperation(profile, operation);
      }
      if (operation.promptAccepted && !isDefinitePromptRejection(error)) {
        if (!detached) this.publishFailure(profile.id, error);
        return { pending: true, sessionId: operation.sessionId };
      }
      throw error;
    } finally {
      if (!detached) this.releaseOperation(profile.id, operation);
    }
  }

  /** Runs one prompt through the managed RPC session, then returns the reconciled transcript. */
  async promptSession(profileId: string, sessionId: string, text: string): Promise<RemoteSessionTranscript | RemoteSessionSubmissionPending> {
    await this.awaitProfileStartupRecovery(profileId);
    const profile = await this.store.get(profileId);
    const record = this.db.getRemoteSession(profile.id, sessionId);
    if (!record) throw new PiRemoteError("session-not-found", `Remote session ${sessionId} is not in the local index.`, { phase: "session", retryable: true });
    const operation = this.reserveOperation(profile.id, sessionId, record.cwd);
    let detached = false;
    try {
      await promptManagedRemoteSession(
        this.runtime,
        profile,
        sessionId,
        text,
        {
          onPort: async (port) => {
            operation.port = port;
            operation.phase = "attached";
            this.updateOperationStatus(profile.id, operation, "running");
            if (operation.abortRequested) {
              await port.abort().catch(() => {});
              throw new PiRemoteError("remote-prompt-aborted", "The remote prompt was stopped before it started.", { phase: "session" });
            }
          },
          onPromptAccepted: () => {
            operation.promptAccepted = true;
          }
        }
      );
      operation.port = null;
      await this.refreshSessions(profile.id);
      return await this.openSession(profile.id, sessionId, true);
    } catch (error) {
      if (isDetachedPromptFailure(error)) {
        detached = true;
        operation.phase = "detached";
        this.updateOperationStatus(profile.id, operation, "reconnecting");
        this.monitorDetachedOperation(profile, operation);
      }
      if (operation.promptAccepted && !isDefinitePromptRejection(error)) {
        if (!detached) this.publishFailure(profile.id, error);
        return { pending: true, sessionId: operation.sessionId };
      }
      throw error;
    } finally {
      if (!detached) this.releaseOperation(profile.id, operation);
    }
  }

  /** Explicit cancellation is the only renderer action that aborts active remote work. */
  async abortSession(profileId: string, sessionId?: string): Promise<boolean> {
    const operation = this.activeOperations.get(profileId);
    if (!operation || sessionId && operation.sessionId !== sessionId) return false;
    operation.abortRequested = true;
    this.updateOperationStatus(profileId, operation, "stopping");
    if (operation.phase === "attached" && operation.port) {
      try {
        await operation.port.abort();
      } catch {
        operation.port = null;
        operation.phase = "detached";
        const profile = await this.store.get(profileId);
        this.monitorDetachedOperation(profile, operation);
      }
      return true;
    }
    if (operation.phase === "detached") {
      const profile = await this.store.get(profileId);
      this.monitorDetachedOperation(profile, operation);
    }
    // Opening and post-settlement reconciliation remain owned by the original
    // request. Its callbacks observe abortRequested and its finally releases.
    return true;
  }

  /**
   * Renders one session, downloading only what the local copy does not have.
   * The header fingerprint decides whether the cached prefix is still the remote
   * prefix; when it is not, the file is fetched again from zero rather than
   * appended to, because a resumed offset would splice two different transcripts.
   */
  async openSession(profileId: string, sessionId: string, refetch = false): Promise<RemoteSessionTranscript> {
    const profile = await this.store.get(profileId);
    const record = this.db.getRemoteSession(profile.id, sessionId);
    if (!record) {
      throw new PiRemoteError("session-not-found", "This remote session is not in the local list yet.", {
        phase: "session",
        remediation: "Refresh the session list for this profile."
      });
    }

    const transcriptPath = this.transcriptPathFor(profile.id, sessionId);
    const plan = resolveSessionSyncPlan({
      cachedBytes: record.cachedBytes,
      cachedFingerprint: record.cachedFingerprint,
      headerFingerprint: record.headerFingerprint,
      remoteSizeBytes: record.remoteSizeBytes,
      transcriptExists: existsSync(transcriptPath),
      missing: record.state === "gone"
    }, { refetch });

    let fetchedBytes = 0;
    let refetched = plan.mode === "full" && record.cachedBytes > 0;
    if (plan.mode !== "cached") {
      const result = await this.syncTranscript(
        profile,
        sessionId,
        transcriptPath,
        plan.mode === "append" ? plan.fromOffset : 0,
        record.cachedFingerprint
      );
      fetchedBytes = result.fetchedBytes;
      refetched = refetched || result.restarted;
    }

    const previousBytes = refetched ? 0 : record.cachedBytes;
    const raw = await readFile(transcriptPath, "utf8").catch(() => "");
    // With nothing fetched, nothing is new, so no row is marked as arriving now.
    const entries = readTranscriptEntries(raw, fetchedBytes > 0 ? previousBytes : Number.POSITIVE_INFINITY);
    const updated = this.db.getRemoteSession(profile.id, sessionId) ?? record;
    return this.toTranscript(updated, entries, { fetchedBytes, refetched });
  }

  /**
   * Lists remote directories for the workspace picker over a plain SSH command,
   * so it works before the managed runtime is installed. Names are transported
   * base64-encoded because a directory name may contain anything but a slash.
   */
  async listDirectory(profileId: string, directory?: string): Promise<RemoteDirectoryListing> {
    const profile = await this.store.get(profileId);
    const target = normalizeRemotePath(directory ?? profile.defaultCwd ?? "/");
    const command = [
      "set -eu",
      `dir=${shellQuote(target)}`,
      'test -d "$dir"',
      'cd "$dir"',
      "for entry in *; do",
      '  [ -d "$entry" ] || continue',
      '  flags=d',
      '  if [ -w "$entry" ]; then flags="${flags}w"; fi',
      '  if [ -d "$entry/.git" ]; then flags="${flags}g"; fi',
      '  printf "%s %s\\n" "$flags" "$(printf "%s" "$entry" | base64 | tr -d "\\n")"',
      "done"
    ].join("\n");
    const result = await this.runtime.ssh.run(profile, command);
    if (result.code !== 0) {
      throw new PiRemoteError("remote-directory-failed", `Cannot list ${target} on the remote host.`, {
        phase: "session",
        remediation: "Check that the path exists and the SSH user can read it.",
        safeDetails: { path: target }
      });
    }
    const inUse = new Set([
      ...this.db.listRemoteSessionCwds(profile.id),
      ...this.db.listRemoteWorkspaces(profile.id).map((workspace) => workspace.cwd)
    ]);
    const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const entries: RemoteDirectoryEntry[] = [];
    for (const line of lines.slice(0, DIRECTORY_ENTRY_LIMIT)) {
      const [flags, encoded] = line.split(" ");
      if (!flags || !encoded) continue;
      const name = Buffer.from(encoded, "base64").toString("utf8");
      if (!name || name.includes("/") || name.includes("\0")) continue;
      const entryPath = joinRemotePath(target, name);
      entries.push({
        name,
        path: entryPath,
        writable: flags.includes("w"),
        gitRepository: flags.includes("g"),
        inUse: inUse.has(entryPath)
      });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return {
      profileId: profile.id,
      path: target,
      parentPath: parentRemotePath(target),
      entries,
      truncated: lines.length > DIRECTORY_ENTRY_LIMIT
    };
  }

  private async syncTranscript(
    profile: RemoteProfile,
    sessionId: string,
    transcriptPath: string,
    fromOffset: number,
    cachedFingerprint: string | null
  ): Promise<{ fetchedBytes: number; restarted: boolean }> {
    let result;
    try {
      result = await syncSessionFile({
        transcriptPath,
        fromOffset,
        expectedFingerprint: cachedFingerprint,
        maxSyncBytes: MAX_SESSION_SYNC_BYTES,
        readChunk: (offset) => this.runtime.readSession(profile, sessionId, {
          fromOffset: offset,
          maxBytes: SESSION_READ_CHUNK_BYTES,
          install: false
        }),
        onTooLarge: (totalBytes) => new PiRemoteError("session-too-large", "This remote session is too large to mirror locally.", {
          phase: "session",
          remediation: "Open it in the remote terminal instead.",
          safeDetails: { totalBytes, limitBytes: MAX_SESSION_SYNC_BYTES }
        })
      });
    } catch (error) {
      this.publishFailure(profile.id, error);
      throw error;
    }

    // Written only after the staged copy has replaced the published one, so the
    // stored offset never describes bytes that are not on disk.
    this.db.updateRemoteSessionCache({
      profileId: profile.id,
      sessionId,
      cachedBytes: result.offset,
      cachedFingerprint: result.fingerprint,
      transcriptPath,
      syncedAt: new Date().toISOString(),
      remoteSizeBytes: result.remoteSize
    });
    return { fetchedBytes: result.fetchedBytes, restarted: result.restarted };
  }

  private toTranscript(
    record: RemoteSessionRecord,
    entries: RemoteTranscriptEntry[],
    sync: { fetchedBytes: number; refetched: boolean }
  ): RemoteSessionTranscript {
    const omittedEntryCount = Math.max(0, entries.length - TRANSCRIPT_ENTRY_LIMIT);
    return {
      profileId: record.profileId,
      sessionId: record.sessionId,
      title: record.title,
      cwd: record.cwd,
      state: record.state,
      entries: omittedEntryCount > 0 ? entries.slice(omittedEntryCount) : entries,
      omittedEntryCount,
      cachedBytes: record.cachedBytes,
      remoteSizeBytes: record.remoteSizeBytes,
      fetchedBytes: sync.fetchedBytes,
      refetched: sync.refetched,
      syncedAt: record.syncedAt
    };
  }

  private transcriptPathFor(profileId: string, sessionId: string): string {
    // Session ids come from remote session headers, so they are never used as a
    // path segment without being reduced to safe characters first.
    const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128);
    return path.join(this.transcriptRoot, profileId, `${safeSessionId}.jsonl`);
  }

  private publishFailure(profileId: string, error: unknown): RemoteProfileStatus {
    const details = describeError(error);
    return this.publishStatus({
      profileId,
      state: "failed",
      message: details.message,
      errorCode: details.code,
      remediation: details.remediation,
      checkedAt: new Date().toISOString(),
      busy: false
    });
  }

  private publishStatus(patch: Partial<RemoteProfileStatus> & { profileId: string }): RemoteProfileStatus {
    const current = this.statuses.get(patch.profileId) ?? emptyStatus(patch.profileId);
    const next: RemoteProfileStatus = { ...current, ...patch };
    this.statuses.set(next.profileId, next);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("remotes:status-changed", next);
    }
    return next;
  }

  private reserveOperation(
    profileId: string,
    sessionId: string | null,
    cwd: string,
    state: ActiveRemoteOperation["state"] = "running",
    phase: ActiveRemoteOperation["phase"] = "opening"
  ): ActiveRemoteOperation {
    if (this.activeOperations.has(profileId)) {
      throw new PiRemoteError(
        "remote-profile-busy",
        "Another session operation is already active for this remote profile.",
        { phase: "session", retryable: true, remediation: "Wait for it to finish or stop it before starting another session." }
      );
    }
    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const operation: ActiveRemoteOperation = {
      sessionId,
      cwd,
      port: null,
      abortRequested: false,
      phase,
      state,
      promptAccepted: false,
      detachedEgress: null,
      monitoring: false,
      done,
      resolveDone
    };
    this.activeOperations.set(profileId, operation);
    this.publishStatus({ profileId, sessionOperation: operationStatus(operation) });
    return operation;
  }

  private releaseOperation(profileId: string, operation: ActiveRemoteOperation): void {
    if (this.activeOperations.get(profileId) !== operation) return;
    this.activeOperations.delete(profileId);
    this.publishStatus({ profileId, sessionOperation: null });
    operation.resolveDone();
  }

  private updateOperationStatus(profileId: string, operation: ActiveRemoteOperation, state: ActiveRemoteOperation["state"]): void {
    if (this.activeOperations.get(profileId) !== operation) return;
    operation.state = state;
    this.publishStatus({ profileId, sessionOperation: operationStatus(operation) });
  }

  private recoverActiveOperation(profile: RemoteProfile, runtimeInfo: RuntimeInfo): void {
    const active = runtimeInfo.activeRpc;
    if (!active?.busy || this.activeOperations.has(profile.id)) return;
    const operation = this.reserveOperation(
      profile.id,
      active.sessionId,
      normalizeRemotePath(active.cwd),
      "reconnecting",
      "detached"
    );
    this.monitorDetachedOperation(profile, operation, runtimeInfo);
  }

  private async recoverActiveOperationsOnStartup(): Promise<void> {
    let profiles: RemoteProfile[];
    try {
      profiles = await this.store.list();
    } catch {
      return;
    }
    for (const profile of profiles) {
      const recovery = this.recoverProfileOnStartup(profile);
      this.startupRecoveryByProfile.set(profile.id, recovery);
      void recovery.then(() => {
        if (this.startupRecoveryByProfile.get(profile.id) === recovery) {
          this.startupRecoveryByProfile.delete(profile.id);
        }
      });
    }
  }

  private async awaitProfileStartupRecovery(profileId: string): Promise<void> {
    // The first promise only discovers and schedules profiles from local JSON.
    // An operation waits for its own SSH probe, never for an unrelated host.
    await this.startupRecovery;
    await this.startupRecoveryByProfile.get(profileId);
  }

  private async recoverProfileOnStartup(profile: RemoteProfile): Promise<void> {
    for (let attempt = 0; attempt < STARTUP_RECOVERY_ATTEMPTS; attempt += 1) {
      try {
        const info = await this.runtime.inspectRuntime(profile, { install: false });
        this.recoverActiveOperation(profile, info);
        return;
      } catch (error) {
        if (error instanceof PiRemoteError && error.code === "runtime-not-installed") return;
        if (!isRetryableError(error)) return;
        if (attempt === STARTUP_RECOVERY_ATTEMPTS - 1) {
          // Only client-proxy work depends on this app staying online after
          // the bounded startup gate. Direct profiles remain daemon-owned and
          // are rediscovered by their next explicit session refresh.
          if (profile.network.mode === "client-proxy") void this.retryStartupRecovery(profile);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }

  private async retryStartupRecovery(profile: RemoteProfile): Promise<void> {
    let delayMs = 2_000;
    while (!this.cancelledStartupRecovery.has(profile.id)) {
      await delayUnref(delayMs);
      if (this.cancelledStartupRecovery.has(profile.id)) return;
      try {
        const info = await this.runtime.inspectRuntime(profile, { install: false });
        if (!this.cancelledStartupRecovery.has(profile.id)) this.recoverActiveOperation(profile, info);
        return;
      } catch (error) {
        if (error instanceof PiRemoteError && error.code === "runtime-not-installed") return;
        if (!isRetryableError(error)) return;
        delayMs = Math.min(delayMs * 2, 60_000);
      }
    }
  }

  private monitorDetachedOperation(profile: RemoteProfile, operation: ActiveRemoteOperation, recoveredRuntimeInfo?: RuntimeInfo): void {
    if (operation.monitoring || this.activeOperations.get(profile.id) !== operation) return;
    operation.monitoring = true;
    void (async () => {
      try {
        while (this.activeOperations.get(profile.id) === operation) {
          if (profile.network.mode === "client-proxy" && !operation.port && !operation.detachedEgress) {
            try {
              operation.detachedEgress = await this.runtime.reconnectDetachedEgress(profile, recoveredRuntimeInfo);
              recoveredRuntimeInfo = undefined;
            } catch (error) {
              if (!isRetryableError(error)) throw error;
              this.updateOperationStatus(profile.id, operation, "reconnecting");
              await new Promise((resolve) => setTimeout(resolve, DETACHED_OPERATION_POLL_MS));
              continue;
            }
          }
          if (operation.abortRequested) {
            try {
              await this.runtime.stop(profile);
              await this.refreshSessions(profile.id).catch((error) => { this.publishFailure(profile.id, error); });
              return;
            } catch (error) {
              if (!isRetryableError(error)) throw error;
              await new Promise((resolve) => setTimeout(resolve, DETACHED_OPERATION_POLL_MS));
              continue;
            }
          }
          let info: RuntimeInfo;
          try {
            info = await this.runtime.inspectRuntime(profile, { install: false });
          } catch (error) {
            if (!isRetryableError(error)) throw error;
            this.updateOperationStatus(profile.id, operation, "reconnecting");
            await new Promise((resolve) => setTimeout(resolve, DETACHED_OPERATION_POLL_MS));
            continue;
          }
          const active = info.activeRpc;
          if (!active?.busy) {
            if (active) await this.runtime.stop(profile);
            await this.refreshSessions(profile.id);
            return;
          }
          if (operation.sessionId && active.sessionId && operation.sessionId !== active.sessionId) {
            throw new PiRemoteError(
              "remote-session-changed",
              "The remote daemon is running a different session than the one Jasmine was tracking.",
              { phase: "session", retryable: true }
            );
          }
          await new Promise((resolve) => setTimeout(resolve, DETACHED_OPERATION_POLL_MS));
        }
      } catch (error) {
        if (this.activeOperations.get(profile.id) === operation) {
          this.publishFailure(profile.id, error);
        }
      } finally {
        operation.monitoring = false;
        const cleanup = await Promise.allSettled([
          operation.port?.releaseDetachedResources(),
          operation.detachedEgress?.close()
        ].filter((entry): entry is Promise<void> => Boolean(entry)));
        const failedCleanup = cleanup.find((entry) => entry.status === "rejected");
        if (failedCleanup?.status === "rejected" && this.activeOperations.get(profile.id) === operation) {
          this.publishFailure(profile.id, failedCleanup.reason);
        }
        this.releaseOperation(profile.id, operation);
      }
    })();
  }
}

let service: RemoteProfileService | null = null;

export function getRemoteProfileService(db: JasmineDatabase): RemoteProfileService {
  if (!service) service = new RemoteProfileService(db);
  return service;
}

export function resetRemoteProfileService(): void {
  service = null;
}

/**
 * The Linux runtime archive is fetched into the pi-remote package folder during
 * install and copied into a packaged build as an app resource. It is resolved
 * from the app root rather than from this module, because the compiled output
 * lives under `dist/` while the archive never moves out of `src/`. When neither
 * location has it, doctor reports the missing artifact rather than the app
 * guessing at a path.
 */
function resolveArtifactDirectory(): string {
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, "pi-remote-runtime", "linux-x64-glibc")
    : null;
  if (packaged && existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), "src", "main", "agent", "extensions", "piRemote", "runtime", "linux-x64-glibc");
}

function emptyStatus(profileId: string): RemoteProfileStatus {
  return {
    profileId,
    state: "unknown",
    message: null,
    errorCode: null,
    remediation: null,
    runtimeVersion: null,
    piVersion: null,
    checkedAt: null,
    busy: false,
    sessionOperation: null
  };
}

function operationStatus(operation: ActiveRemoteOperation): NonNullable<RemoteProfileStatus["sessionOperation"]> {
  return { sessionId: operation.sessionId, cwd: operation.cwd, state: operation.state };
}

function firstFailure(checks: Array<{ status: string; message: string }>): string | null {
  return checks.find((check) => check.status === "fail")?.message ?? null;
}

function describeError(error: unknown): { code: string | null; message: string; remediation: string | null } {
  if (error instanceof PiRemoteError) {
    return { code: error.code, message: error.message, remediation: error.remediation ?? null };
  }
  return { code: null, message: error instanceof Error ? error.message : "The remote host could not be reached.", remediation: null };
}

function isRetryableError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true);
}

function delayUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function toProfileSummary(profile: RemoteProfile): RemoteProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    sshHost: profile.sshHost,
    sshPort: profile.sshPort ?? null,
    defaultCwd: profile.defaultCwd ?? null,
    networkMode: profile.network.mode,
    noProxy: [...profile.network.clientProxy.noProxy],
    allowedPorts: [...profile.network.clientProxy.allowedPorts],
    upstreamProxyEnv: profile.network.clientProxy.upstreamProxyEnv ?? null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function toSessionSummary(record: RemoteSessionRecord): RemoteSessionSummary {
  return {
    profileId: record.profileId,
    sessionId: record.sessionId,
    cwd: record.cwd,
    title: record.title,
    name: record.name,
    preview: record.preview,
    turnCount: record.turnCount,
    remoteCreatedAt: record.remoteCreatedAt,
    remoteUpdatedAt: record.remoteUpdatedAt,
    remoteSizeBytes: record.remoteSizeBytes,
    cachedBytes: record.cachedBytes,
    state: record.state,
    listedAt: record.listedAt
  };
}

