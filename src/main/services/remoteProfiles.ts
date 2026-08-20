import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  resolveSessionSyncPlan
} from "./remoteTranscript.js";
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
import type { RemoteProfile, RemoteSessionMetadata } from "../agent/extensions/piRemote/types.js";

/** Entries rendered for one session. Older ones are summarized rather than mounted. */
const TRANSCRIPT_ENTRY_LIMIT = 400;
const DIRECTORY_ENTRY_LIMIT = 300;
/** One incremental read; a larger gap loops until it reaches the end. */
const SESSION_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_SESSION_SYNC_BYTES = 64 * 1024 * 1024;

export class RemoteProfileService {
  private readonly store: ProfileStore;
  private readonly runtime: ManagedRemoteRuntime;
  private readonly statuses = new Map<string, RemoteProfileStatus>();
  private readonly transcriptRoot: string;

  constructor(
    private readonly db: JasmineDatabase,
    options: { store?: ProfileStore; runtime?: ManagedRemoteRuntime; transcriptRoot?: string } = {}
  ) {
    this.store = options.store ?? new ProfileStore();
    this.runtime = options.runtime ?? new ManagedRemoteRuntime({ artifactDirectory: resolveArtifactDirectory() });
    this.transcriptRoot = options.transcriptRoot ?? path.join(app.getPath("userData"), "remote-sessions");
  }

  async listProfiles(): Promise<RemoteProfileSummary[]> {
    const profiles = await this.store.list();
    return profiles.map(toProfileSummary).sort((left, right) =>
      left.sshHost.localeCompare(right.sshHost) || left.name.localeCompare(right.name));
  }

  async createProfile(request: RemoteProfileCreateRequest): Promise<RemoteProfileSummary> {
    const profile = await this.store.add({
      name: request.name,
      sshHost: request.sshHost,
      ...(request.sshPort ? { sshPort: request.sshPort } : {}),
      ...(request.defaultCwd ? { defaultCwd: request.defaultCwd } : {}),
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
    const profile = await this.store.update(profileId, patch);
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
    const profile = await this.store.get(profileId);
    const transcripts = this.db.removeRemoteProfileData(profile.id);
    await Promise.all(transcripts.map((file) => rm(file, { force: true }).catch(() => {})));
    await rm(path.join(this.transcriptRoot, profile.id), { recursive: true, force: true }).catch(() => {});
    await this.store.remove(profile.id);
    this.statuses.delete(profile.id);
  }

  async checkProfile(profileId: string): Promise<RemoteDoctorReport> {
    const profile = await this.store.get(profileId);
    this.publishStatus({ profileId: profile.id, state: "checking", busy: true });
    try {
      const report = await this.runtime.doctor(profile);
      const checkedAt = new Date().toISOString();
      const runtimeMissing = report.checks.some((check) => check.id === "artifact" && check.status === "fail");
      this.publishStatus({
        profileId: profile.id,
        state: report.ok ? "ready" : runtimeMissing ? "needsSetup" : "failed",
        message: report.ok ? null : firstFailure(report.checks),
        checkedAt,
        busy: false
      });
      return {
        profileId: profile.id,
        ok: report.ok,
        checks: report.checks.map((check) => ({ id: check.id, status: check.status, message: check.message })),
        checkedAt
      };
    } catch (error) {
      this.publishFailure(profile.id, error);
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
    const profile = await this.store.get(profileId);
    this.publishStatus({ profileId: profile.id, state: "checking", busy: true });
    try {
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
    const defaultCwdByProfile = new Map(profiles.map((profile) => [profile.id, profile.defaultCwd ?? null]));
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
    const workspace = this.db.upsertRemoteWorkspace({
      profileId: profile.id,
      cwd: request.cwd,
      ...(request.name ? { name: request.name } : {}),
      source: "manual"
    });
    if (request.setDefault) await this.store.update(profile.id, { defaultCwd: request.cwd });
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
   */
  async refreshSessions(profileId: string): Promise<RemoteSessionSummary[]> {
    const profile = await this.store.get(profileId);
    this.publishStatus({ profileId: profile.id, state: "checking", busy: true });
    let sessions: RemoteSessionMetadata[];
    try {
      sessions = await this.runtime.listSessions(profile);
    } catch (error) {
      this.publishFailure(profile.id, error);
      throw error;
    }
    this.db.replaceRemoteSessionListing(profile.id, sessions.map((session) => ({
      profileId: profile.id,
      sessionId: session.id,
      cwd: session.cwd || "",
      name: session.name ?? null,
      preview: session.preview ?? null,
      turnCount: session.turnCount ?? null,
      remoteCreatedAt: session.createdAt,
      remoteUpdatedAt: session.updatedAt ?? null,
      remoteSizeBytes: session.sizeBytes ?? null,
      headerFingerprint: session.headerFingerprint ?? null
    })));
    for (const cwd of this.db.listRemoteSessionCwds(profile.id)) {
      this.db.upsertRemoteWorkspace({ profileId: profile.id, cwd, source: "discovered" });
    }
    this.publishStatus({
      profileId: profile.id,
      state: "ready",
      message: null,
      errorCode: null,
      remediation: null,
      checkedAt: new Date().toISOString(),
      busy: false
    });
    return this.listSessions(profile.id);
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
      const result = await this.syncTranscript(profile, sessionId, transcriptPath, plan.mode === "append" ? plan.fromOffset : 0);
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
    fromOffset: number
  ): Promise<{ fetchedBytes: number; restarted: boolean }> {
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    let offset = fromOffset;
    let fetchedBytes = 0;
    let restarted = false;
    let fingerprint: string | null = null;
    let remoteSize: number | null = null;

    if (offset === 0) await writeFile(transcriptPath, "", "utf8");

    for (;;) {
      let chunk;
      try {
        chunk = await this.runtime.readSession(profile, sessionId, { fromOffset: offset, maxBytes: SESSION_READ_CHUNK_BYTES });
      } catch (error) {
        // A cursor the host will not accept means the remote file was replaced
        // or truncated. Start over once rather than fail the open.
        if (offset > 0 && error instanceof PiRemoteError && error.code === "session-offset-past-end") {
          offset = 0;
          restarted = true;
          fetchedBytes = 0;
          await writeFile(transcriptPath, "", "utf8");
          continue;
        }
        this.publishFailure(profile.id, error);
        throw error;
      }
      if (fingerprint && chunk.headerFingerprint !== fingerprint) {
        // The file changed identity mid-download; the partial copy is unusable.
        offset = 0;
        restarted = true;
        fetchedBytes = 0;
        fingerprint = null;
        await writeFile(transcriptPath, "", "utf8");
        continue;
      }
      fingerprint = chunk.headerFingerprint;
      remoteSize = chunk.size;
      if (chunk.bytes > 0) {
        await appendFile(transcriptPath, Buffer.from(chunk.data, "base64"));
        offset += chunk.bytes;
        fetchedBytes += chunk.bytes;
      }
      if (chunk.eof || chunk.bytes === 0) break;
      if (fetchedBytes > MAX_SESSION_SYNC_BYTES) {
        throw new PiRemoteError("session-too-large", "This remote session is too large to mirror locally.", {
          phase: "session",
          remediation: "Open it in the remote terminal instead.",
          safeDetails: { fetchedBytes }
        });
      }
    }

    this.db.updateRemoteSessionCache({
      profileId: profile.id,
      sessionId,
      cachedBytes: offset,
      cachedFingerprint: fingerprint,
      transcriptPath,
      syncedAt: new Date().toISOString(),
      remoteSizeBytes: remoteSize
    });
    return { fetchedBytes, restarted };
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
    busy: false
  };
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

