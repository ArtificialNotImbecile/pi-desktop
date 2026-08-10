import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import watcher from "@parcel/watcher";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
  ToolResultEvent
} from "@earendil-works/pi-coding-agent";
import {
  createUnifiedDiffs,
  initializeSnapshotRepository,
  isExcludedAbsolutePath,
  listChangedPaths,
  removeSnapshotRepository,
  snapshotRoot,
  type RootSnapshot,
  type SnapshotFile,
  type SnapshotRepository
} from "./gitSnapshot.js";
import type { FileContentRedactionPredicate, FileRedactionPredicate } from "./redaction.js";
import {
  DEFAULT_DIFF_BYTE_LIMIT,
  DEFAULT_MAX_CHANGES,
  DEFAULT_MAX_CONTENT_BYTES,
  DEFAULT_MAX_MANAGED_TARGETS,
  DEFAULT_MAX_RUN_CAPTURED_CONTENT_BYTES,
  DEFAULT_TEXT_BYTE_LIMIT,
  FILE_CHANGES_ENTRY_TYPE,
  FILE_CHANGES_EXCLUDES,
  FILE_CHANGES_SCHEMA_VERSION,
  type FileChange,
  type FileChangeCapture,
  type FileChangeCounts,
  type FileChangeCoverage,
  type FileChangeCoverageIssue,
  type FileChangeCoverageRoot,
  type FileChangeEntry,
  type FileChangeTrackingMode,
  type FileContentKind,
  type ImageFileContent,
  type Utf8FileContent
} from "./schema.js";

const MAX_CAPTURE_WARNINGS = 100;
const MAX_CAPTURE_ISSUES = 100;

export * from "./redaction.js";
export * from "./schema.js";

export interface FileChangeExtensionOptions {
  /** Tracking strategy. Defaults to managed-tools-only. */
  trackingMode?: FileChangeTrackingMode;
  /** Root observed by watcher mode. Defaults to ctx.cwd. No initial scan is performed. */
  watchRoot?: string | ((ctx: ExtensionContext) => string | Promise<string>);
  /** Receives the complete changed-only capture. */
  onCapture?: (capture: FileChangeCapture) => void | Promise<void>;
  /** Write a complete JSON manifest. Defaults to false. */
  persistManifest?: boolean;
  /** Append a metadata-only custom entry to the Pi session. Defaults to true. */
  appendEntry?: boolean;
  /** Manifest directory. Relative paths resolve from ctx.cwd. */
  manifestDirectory?: string;
  /** Require manifestDirectory to resolve outside ctx.cwd. Used by safe CLI opt-in. */
  requireExternalManifestDirectory?: boolean;
  /** Maximum UTF-8 bytes retained for each before/after text side. */
  maxTextBytes?: number;
  /** Maximum UTF-8 bytes retained for each unified diff. */
  maxDiffBytes?: number;
  /** Maximum bytes read from one observed file. Larger files retain path/status only. */
  maxContentBytes?: number;
  /** Maximum raw preview bytes retained across the run. */
  maxRunCapturedContentBytes?: number;
  /** Maximum distinct write/edit targets dynamically baselined in one run. */
  maxManagedTargets?: number;
  /** Maximum changed-file records materialized in one capture. */
  maxChanges?: number;
  /** Adds host-specific sensitive paths to the built-in fail-safe patterns. */
  shouldRedact?: FileRedactionPredicate;
  /** Adds host-specific content redaction; exceptions fail closed. */
  shouldRedactContent?: FileContentRedactionPredicate;
  /** Parent for the lazily-created temporary bare Git diff repository. */
  temporaryDirectory?: string;
}

interface ExactTargetState {
  id: string;
  root: string;
  filePath: string;
  requestedPath: string;
  beforeExists: boolean;
  before: RootSnapshot;
  successfulTouches: number;
}

interface WatchCandidate {
  path: string;
  first: "create" | "update" | "delete";
  last: "create" | "update" | "delete";
  deletedAfterCreate: boolean;
}

interface RunState {
  cwd: string;
  startedAt: string;
  mode: FileChangeTrackingMode;
  watchRoot?: string;
  watchPhysicalRoot?: string;
  watchSubscription?: watcher.AsyncSubscription;
  watchCandidates: Map<string, WatchCandidate>;
  repository: SnapshotRepository | null;
  temporaryDirectory?: string;
  exactTargets: Map<string, ExactTargetState>;
  toolTargets: Map<string, string>;
  warnings: string[];
  issues: FileChangeCoverageIssue[];
  failureReason?: string;
  bashInvoked: boolean;
  shouldRedact?: FileRedactionPredicate;
  shouldRedactContent?: FileContentRedactionPredicate;
  limits: {
    maxContentBytes: number;
    maxRunCapturedContentBytes: number;
    maxManagedTargets: number;
    maxChanges: number;
  };
  capturedContentBytes: number;
  registrationQueue: Promise<void>;
  sequence: number;
}

export function createFileChangeExtension(options: FileChangeExtensionOptions = {}): ExtensionFactory {
  const persistManifest = options.persistManifest ?? false;
  const appendEntry = options.appendEntry ?? true;
  const maxTextBytes = positiveInteger(options.maxTextBytes, DEFAULT_TEXT_BYTE_LIMIT);
  const maxDiffBytes = positiveInteger(options.maxDiffBytes, DEFAULT_DIFF_BYTE_LIMIT);
  const limits = {
    maxContentBytes: positiveInteger(options.maxContentBytes, DEFAULT_MAX_CONTENT_BYTES),
    maxRunCapturedContentBytes: positiveInteger(options.maxRunCapturedContentBytes, DEFAULT_MAX_RUN_CAPTURED_CONTENT_BYTES),
    maxManagedTargets: positiveInteger(options.maxManagedTargets, DEFAULT_MAX_MANAGED_TARGETS),
    maxChanges: positiveInteger(options.maxChanges, DEFAULT_MAX_CHANGES)
  };

  return function fileChangeExtension(pi: ExtensionAPI): void {
    let activeRun: RunState | null = null;

    pi.on("agent_start", async (_event, ctx) => {
      if (activeRun) return;
      activeRun = await beginRun(ctx, options, limits);
    });

    pi.on("tool_call", async (event, ctx) => {
      if (!activeRun) return;
      if (event.toolName === "bash") {
        activeRun.bashInvoked = true;
        return;
      }
      if (event.toolName !== "write" && event.toolName !== "edit") return;
      const run = activeRun;
      run.registrationQueue = run.registrationQueue.then(() => registerWriteTarget(run, event, ctx));
      await run.registrationQueue;
    });

    pi.on("tool_result", async (event) => {
      if (!activeRun || (event.toolName !== "write" && event.toolName !== "edit")) return;
      await activeRun.registrationQueue;
      markToolResult(activeRun, event);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      const run = activeRun;
      activeRun = null;
      if (!run) return;
      let callbackError: unknown;
      try {
        await run.registrationQueue;
        await stopWatcher(run);
        let capture = await finishRun(run, maxTextBytes, maxDiffBytes);
        await cleanupRepository(run, (warning) => {
          capture = addCaptureWarning(capture, warning);
        });
        let manifestPath: string | null = null;
        if (persistManifest) {
          try {
            manifestPath = await persistCaptureManifest(
              capture,
              ctx.cwd,
              options.manifestDirectory,
              options.requireExternalManifestDirectory ?? false
            );
          } catch (error) {
            capture = addCaptureWarning(capture, `Could not persist file-change manifest: ${errorMessage(error)}`);
          }
        }
        try {
          await options.onCapture?.(capture);
        } catch (error) {
          callbackError = error;
        }
        if (appendEntry) pi.appendEntry(FILE_CHANGES_ENTRY_TYPE, compactEntry(capture, manifestPath));
      } finally {
        await stopWatcher(run);
        await cleanupRepository(run);
      }
      if (callbackError) throw callbackError;
    });

    pi.on("session_shutdown", async () => {
      const run = activeRun;
      activeRun = null;
      if (!run) return;
      await stopWatcher(run);
      await cleanupRepository(run);
    });
  };
}

/** Default Pi CLI entrypoint discovered through package.json pi.extensions. */
export default function fileChanges(pi: ExtensionAPI): void {
  const manifestDirectory = process.env.PI_FILE_CHANGES_MANIFEST_DIR?.trim();
  const configuredMode = process.env.PI_FILE_CHANGES_MODE?.trim();
  const trackingMode: FileChangeTrackingMode = configuredMode === "watcher" ? "watcher" : "managed-tools-only";
  if (configuredMode && configuredMode !== "watcher" && configuredMode !== "managed-tools-only") {
    console.warn("PI_FILE_CHANGES_MODE must be managed-tools-only or watcher; using managed-tools-only.");
  }
  if (manifestDirectory && path.isAbsolute(manifestDirectory)) {
    createFileChangeExtension({
      trackingMode,
      persistManifest: true,
      manifestDirectory,
      requireExternalManifestDirectory: true
    })(pi);
    return;
  }
  if (manifestDirectory) {
    console.warn("PI_FILE_CHANGES_MANIFEST_DIR must be an absolute external directory; full manifests remain disabled.");
  }
  createFileChangeExtension({ trackingMode })(pi);
}

async function beginRun(
  ctx: ExtensionContext,
  options: FileChangeExtensionOptions,
  limits: RunState["limits"]
): Promise<RunState> {
  const run: RunState = {
    cwd: path.resolve(ctx.cwd),
    startedAt: new Date().toISOString(),
    mode: options.trackingMode ?? "managed-tools-only",
    watchCandidates: new Map(),
    repository: null,
    ...(options.temporaryDirectory ? { temporaryDirectory: options.temporaryDirectory } : {}),
    exactTargets: new Map(),
    toolTargets: new Map(),
    warnings: [],
    issues: [],
    bashInvoked: false,
    shouldRedact: options.shouldRedact,
    shouldRedactContent: options.shouldRedactContent,
    limits,
    capturedContentBytes: 0,
    registrationQueue: Promise.resolve(),
    sequence: 0
  };
  if (run.mode !== "watcher") return run;

  try {
    const configured = typeof options.watchRoot === "function"
      ? await options.watchRoot(ctx)
      : options.watchRoot ?? ctx.cwd;
    const requestedRoot = resolveFromCwd(configured, ctx.cwd);
    run.watchRoot = requestedRoot;
    run.watchPhysicalRoot = await realpath(requestedRoot);
    run.watchSubscription = await watcher.subscribe(
      run.watchPhysicalRoot,
      (error, events) => {
        if (error) {
          recordWatcherFailure(run, error);
          return;
        }
        for (const event of events) recordWatchEvent(run, event.path, event.type);
      },
      { ignore: [...FILE_CHANGES_EXCLUDES] }
    );
  } catch (error) {
    recordWatcherFailure(run, error);
  }
  return run;
}

async function registerWriteTarget(run: RunState, event: ToolCallEvent, ctx: ExtensionContext): Promise<void> {
  const input = event.input as Record<string, unknown>;
  const rawPath = typeof input.path === "string" ? input.path.trim() : "";
  if (!rawPath) {
    run.warnings.push(`${event.toolName} call ${event.toolCallId} did not expose a usable path.`);
    return;
  }
  const requestedPath = resolveFromCwd(rawPath, ctx.cwd);
  const canonicalPath = await canonicalizePotentialPath(requestedPath, run.warnings, "managed file target");
  const key = normalizePathForIdentity(canonicalPath);
  if (isExcludedAbsolutePath(requestedPath) || isExcludedAbsolutePath(canonicalPath)) {
    run.warnings.push(`Write target is excluded by file-change policy: ${canonicalPath}`);
    return;
  }
  run.toolTargets.set(event.toolCallId, key);
  if (run.exactTargets.has(key)) return;
  if (run.exactTargets.size >= run.limits.maxManagedTargets) {
    recordIssue(run, "max-managed-targets", canonicalPath, "baseline", `Maximum managed write/edit target count ${run.limits.maxManagedTargets} reached.`);
    return;
  }
  const beforeExists = await pathExists(canonicalPath);
  const before = await snapshotSingleFile(run, canonicalPath, "baseline");
  run.exactTargets.set(key, {
    id: rootId(`file\0${canonicalPath}`),
    root: path.dirname(canonicalPath),
    filePath: canonicalPath,
    requestedPath,
    beforeExists,
    before,
    successfulTouches: 0
  });
}

function markToolResult(run: RunState, event: ToolResultEvent): void {
  const key = run.toolTargets.get(event.toolCallId);
  run.toolTargets.delete(event.toolCallId);
  if (!key || event.isError) return;
  const target = run.exactTargets.get(key);
  if (target) target.successfulTouches += 1;
}

async function finishRun(run: RunState, maxTextBytes: number, maxDiffBytes: number): Promise<FileChangeCapture> {
  const changes: FileChange[] = [];
  const exactKeys = new Set<string>();
  for (const target of [...run.exactTargets.values()].sort((a, b) => stableCompare(a.filePath, b.filePath))) {
    if (target.successfulTouches === 0 || changes.length >= run.limits.maxChanges) continue;
    exactKeys.add(normalizePathForIdentity(target.filePath));
    const afterExists = await pathExists(target.filePath);
    const after = await snapshotSingleFile(run, target.filePath, "final", target.id);
    const materialized = await materializeManagedTarget(run, target, after, afterExists, maxTextBytes, maxDiffBytes);
    if (materialized) changes.push(materialized);
  }

  if (run.mode === "watcher" && changes.length < run.limits.maxChanges) {
    for (const candidate of [...run.watchCandidates.values()].sort((a, b) => stableCompare(a.path, b.path))) {
      if (changes.length >= run.limits.maxChanges) break;
      const canonicalPath = await canonicalizePotentialPath(candidate.path, [], "watcher path");
      if (exactKeys.has(normalizePathForIdentity(canonicalPath)) || isExcludedAbsolutePath(canonicalPath)) continue;
      const change = await materializeWatchCandidate(run, candidate, canonicalPath, maxTextBytes);
      if (change) changes.push(change);
    }
  }
  if (changes.length >= run.limits.maxChanges && (run.exactTargets.size + run.watchCandidates.size) > changes.length) {
    recordIssue(run, "max-changes", run.watchRoot ?? run.cwd, "final", `Maximum captured change count ${run.limits.maxChanges} reached.`);
  }
  changes.sort(compareChanges);
  const capturedAt = new Date().toISOString();
  return {
    schemaVersion: FILE_CHANGES_SCHEMA_VERSION,
    captureId: createCaptureId(run.startedAt, capturedAt, changes),
    startedAt: run.startedAt,
    capturedAt,
    coverage: createCoverage(run),
    counts: countChanges(changes),
    changes
  };
}

async function materializeManagedTarget(
  run: RunState,
  target: ExactTargetState,
  after: RootSnapshot,
  afterExists: boolean,
  maxTextBytes: number,
  maxDiffBytes: number
): Promise<FileChange | null> {
  const changed = (await listChangedPaths(target.before, after))[0];
  if (!changed) {
    if (target.before.complete && after.complete) return null;
    const status = target.beforeExists ? (afterExists ? "modified" : "deleted") : afterExists ? "added" : null;
    if (!status) return null;
    return createObservedChange(target, status, target.before.files.values().next().value ?? null, after.files.values().next().value ?? null, true);
  }
  const beforeFile = target.before.files.get(changed.path) ?? null;
  const afterFile = after.files.get(changed.path) ?? null;
  const change = createObservedChange(target, changed.status, beforeFile, afterFile, false);
  const redacted = change.redacted;
  const contentAvailable = (!beforeFile || beforeFile.contentAvailable) && (!afterFile || afterFile.contentAvailable);
  if (!redacted && !change.contentOmitted && contentAvailable && change.kind === "text") {
    const repository = await ensureRepository(run);
    if (repository) {
      try {
        const diffs = await createUnifiedDiffs(repository, [{ path: changed.path, before: beforeFile, after: afterFile }], `diff-${run.sequence++}`, maxDiffBytes);
        const diff = diffs.get(changed.path);
        change.text = {
          before: beforeFile?.content ? utf8Content(beforeFile.content, maxTextBytes) : null,
          after: afterFile?.content ? utf8Content(afterFile.content, maxTextBytes) : null,
          ...(diff ? { unifiedDiff: { format: "unified", text: decodeUtf8Prefix(diff.buffer, maxDiffBytes), byteSize: diff.byteSize, truncated: diff.truncated || diff.byteSize > maxDiffBytes } } : {})
        };
      } catch (error) {
        run.warnings.push(`Could not create unified diff for ${target.filePath}: ${errorMessage(error)}`);
      }
    }
    if (!change.text) {
      change.text = {
        before: beforeFile?.content ? utf8Content(beforeFile.content, maxTextBytes) : null,
        after: afterFile?.content ? utf8Content(afterFile.content, maxTextBytes) : null
      };
    }
  } else if (!redacted && !change.contentOmitted && contentAvailable && change.kind === "image") {
    change.image = {
      before: beforeFile?.content ? imageContent(beforeFile, beforeFile.content) : null,
      after: afterFile?.content ? imageContent(afterFile, afterFile.content) : null
    };
  }
  return change;
}

function createObservedChange(
  target: ExactTargetState,
  status: "added" | "modified" | "deleted",
  beforeFile: SnapshotFile | null,
  afterFile: SnapshotFile | null,
  forcedOmission: boolean
): FileChange {
  const redacted = Boolean(beforeFile?.redacted || afterFile?.redacted);
  const contentOmitted = forcedOmission || Boolean(beforeFile?.contentOmitted || afterFile?.contentOmitted);
  const contentOmittedReason = beforeFile?.contentOmittedReason ?? afterFile?.contentOmittedReason ?? (forcedOmission ? "max-content-bytes" : undefined);
  return {
    rootId: target.id,
    root: target.root,
    path: path.basename(target.filePath),
    absolutePath: target.filePath,
    status,
    kind: resolveChangeKind(beforeFile, afterFile),
    redacted,
    contentOmitted,
    ...(contentOmittedReason ? { contentOmittedReason } : {}),
    before: beforeFile?.metadata ?? null,
    after: afterFile?.metadata ?? null
  };
}

async function materializeWatchCandidate(
  run: RunState,
  candidate: WatchCandidate,
  canonicalPath: string,
  maxTextBytes: number
): Promise<FileChange | null> {
  if (candidate.deletedAfterCreate) return null;
  const exists = await pathExists(canonicalPath);
  const status = watcherStatus(candidate, exists);
  if (!status) return null;
  const snapshot = exists ? await snapshotSingleFile(run, canonicalPath, "final") : emptySnapshot();
  const afterFile = snapshot.files.values().next().value as SnapshotFile | undefined;
  const root = run.watchRoot ?? run.cwd;
  const relative = path.relative(root, canonicalPath).replace(/\\/g, "/") || path.basename(canonicalPath);
  const change: FileChange = {
    rootId: rootId(`watcher\0${run.watchPhysicalRoot ?? root}`),
    root,
    path: relative,
    absolutePath: canonicalPath,
    status,
    kind: afterFile?.kind ?? "other",
    redacted: Boolean(afterFile?.redacted),
    contentOmitted: Boolean(afterFile?.contentOmitted),
    ...(afterFile?.contentOmittedReason ? { contentOmittedReason: afterFile.contentOmittedReason } : {}),
    before: null,
    after: afterFile?.metadata ?? null
  };
  if (!change.redacted && !change.contentOmitted && afterFile?.contentAvailable && afterFile.content && afterFile.kind === "text") {
    change.text = { before: null, after: utf8Content(afterFile.content, maxTextBytes) };
  } else if (!change.redacted && !change.contentOmitted && afterFile?.contentAvailable && afterFile.content && afterFile.kind === "image") {
    change.image = { before: null, after: imageContent(afterFile, afterFile.content) };
  }
  return change;
}

async function snapshotSingleFile(run: RunState, filePath: string, stage: "baseline" | "final", rootIdValue?: string): Promise<RootSnapshot> {
  const root = path.dirname(filePath);
  const remaining = Math.max(0, run.limits.maxRunCapturedContentBytes - run.capturedContentBytes);
  if (remaining === 0) {
    recordIssue(run, "read-error", filePath, stage, `Skipped content identity for ${filePath}: run byte limit ${run.limits.maxRunCapturedContentBytes} reached.`);
    return { files: new Map(), complete: false, issues: [], capturedContentBytes: 0 };
  }
  const readLimit = Math.min(run.limits.maxContentBytes, remaining);
  const warnings: string[] = [];
  const snapshot = await snapshotRoot(null, root, {
    indexName: `${stage}-${run.sequence++}`,
    shouldRedact: run.shouldRedact,
    shouldRedactContent: run.shouldRedactContent,
    includeRelativePaths: [path.basename(filePath)],
    maxFiles: 1,
    maxTotalBytes: readLimit,
    maxContentBytes: run.limits.maxContentBytes,
    maxCapturedContentBytes: Math.min(run.limits.maxContentBytes, remaining),
    ...(remaining < run.limits.maxContentBytes
      ? { capturedContentIssueCode: "max-run-captured-content-bytes" as const, capturedContentIssueLimit: run.limits.maxRunCapturedContentBytes }
      : {}),
    warnings
  });
  run.capturedContentBytes += snapshot.capturedContentBytes;
  for (const warning of warnings) {
    if (!/maximum total bytes/i.test(warning)) run.warnings.push(warning);
  }
  for (const issue of snapshot.issues) {
    const message = issue.code === "max-total-bytes"
      ? `Skipped content identity for ${filePath}: observed-file byte limit ${readLimit} reached.`
      : issue.message;
    run.issues.push({
      code: issue.code === "read-error" || issue.code === "excluded-root" ? issue.code : "read-error",
      stage,
      rootId: rootIdValue ?? rootId(`file\0${filePath}`),
      root,
      ...(issue.path ? { path: issue.path } : { path: filePath }),
      message
    });
  }
  return snapshot;
}

async function ensureRepository(run: RunState): Promise<SnapshotRepository | null> {
  if (run.repository) return run.repository;
  let directory: string | null = null;
  try {
    const parent = path.resolve(run.temporaryDirectory ?? tmpdir());
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(path.join(parent, "pi-file-changes-"));
    run.repository = await initializeSnapshotRepository(directory);
    return run.repository;
  } catch (error) {
    run.warnings.push(`Could not initialize temporary diff repository: ${errorMessage(error)}`);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return null;
  }
}

async function cleanupRepository(run: RunState, onWarning?: (warning: string) => void): Promise<void> {
  const repository = run.repository;
  run.repository = null;
  if (!repository) return;
  try {
    await removeSnapshotRepository(repository);
  } catch (error) {
    const warning = `Temporary file-change diff repository remains at ${repository.directory}: ${errorMessage(error)}`;
    console.warn(warning);
    onWarning?.(warning);
  }
}

async function stopWatcher(run: RunState): Promise<void> {
  const subscription = run.watchSubscription;
  run.watchSubscription = undefined;
  if (!subscription) return;
  try {
    await subscription.unsubscribe();
  } catch (error) {
    recordWatcherFailure(run, error);
  }
}

function recordWatchEvent(run: RunState, eventPath: string, type: "create" | "update" | "delete"): void {
  const absolutePath = path.resolve(eventPath);
  if (isExcludedAbsolutePath(absolutePath)) return;
  const key = normalizePathForIdentity(absolutePath);
  const current = run.watchCandidates.get(key);
  if (!current) {
    run.watchCandidates.set(key, { path: absolutePath, first: type, last: type, deletedAfterCreate: false });
    return;
  }
  current.deletedAfterCreate = current.first === "create" && type === "delete";
  current.last = type;
}

function watcherStatus(candidate: WatchCandidate, exists: boolean): "added" | "modified" | "deleted" | null {
  if (candidate.first === "create") return exists ? "added" : null;
  if (candidate.last === "delete" && !exists) return "deleted";
  if (candidate.first === "delete" && exists) return "modified";
  return exists ? "modified" : "deleted";
}

function recordWatcherFailure(run: RunState, error: unknown): void {
  const message = `Filesystem watcher unavailable for ${run.watchRoot ?? run.cwd}: ${errorMessage(error)}`;
  if (!run.warnings.includes(message)) run.warnings.push(message);
  if (!run.issues.some((issue) => issue.code === "watcher-unavailable")) {
    run.issues.push({
      code: "watcher-unavailable",
      stage: "baseline",
      rootId: rootId(`watcher\0${run.watchRoot ?? run.cwd}`),
      root: run.watchRoot ?? run.cwd,
      message
    });
  }
  run.failureReason = message;
}

function createCoverage(run: RunState): FileChangeCoverage {
  const roots: FileChangeCoverageRoot[] = [...run.exactTargets.values()].map((target) => ({
    id: target.id,
    path: target.root,
    physicalPath: target.root,
    source: "write-target",
    scope: "file",
    filePath: target.filePath,
    requestedPath: target.requestedPath,
    requestedFilePath: target.requestedPath,
    bashCovered: false
  }));
  if (run.mode === "watcher" && run.watchRoot) {
    roots.push({
      id: rootId(`watcher\0${run.watchPhysicalRoot ?? run.watchRoot}`),
      path: run.watchRoot,
      physicalPath: run.watchPhysicalRoot ?? run.watchRoot,
      source: "watcher",
      scope: "watcher",
      bashCovered: true
    });
  }
  const allWarnings = stableUnique(run.warnings);
  const allIssues = [...run.issues].sort(compareCoverageIssues);
  const status: FileChangeCoverage["status"] = run.failureReason
    ? "partial"
    : allWarnings.length > 0 || allIssues.length > 0
      ? "partial"
      : "complete";
  return {
    status,
    ...(run.failureReason || allIssues[0]?.message || allWarnings[0]
      ? { reason: run.failureReason ?? allIssues[0]?.message ?? allWarnings[0] }
      : {}),
    roots: roots.sort((a, b) => stableCompare(a.filePath ?? a.path, b.filePath ?? b.path)),
    excludes: [...FILE_CHANGES_EXCLUDES],
    warnings: allWarnings.slice(0, MAX_CAPTURE_WARNINGS),
    omittedWarningCount: Math.max(0, allWarnings.length - MAX_CAPTURE_WARNINGS),
    partial: status !== "complete",
    issues: allIssues.slice(0, MAX_CAPTURE_ISSUES),
    omittedIssueCount: Math.max(0, allIssues.length - MAX_CAPTURE_ISSUES),
    limits: { ...run.limits, appliesPerObservedFile: true },
    trackingMode: run.mode,
    bashCoverage: run.mode === "watcher" ? "watcher-observed" : "not-tracked",
    bashInvoked: run.bashInvoked
  };
}

function recordIssue(run: RunState, code: FileChangeCoverageIssue["code"], affectedPath: string, stage: "baseline" | "final", message: string): void {
  if (run.issues.some((issue) => issue.code === code && issue.path === affectedPath)) return;
  run.issues.push({ code, stage, rootId: rootId(`issue\0${code}\0${affectedPath}`), root: affectedPath, path: affectedPath, message });
}

async function persistCaptureManifest(capture: FileChangeCapture, cwd: string, configuredDirectory: string | undefined, requireExternal: boolean): Promise<string> {
  const directory = path.resolve(cwd, configuredDirectory ?? path.join(".pi", "file-changes"));
  if (requireExternal && isPathInside(cwd, directory)) throw new Error("Manifest directory must be outside the working directory.");
  await mkdir(directory, { recursive: true });
  const finalPath = path.join(directory, `${capture.captureId}.json`);
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(capture, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, finalPath);
  return finalPath;
}

function compactEntry(capture: FileChangeCapture, manifestPath: string | null): FileChangeEntry {
  return {
    schemaVersion: capture.schemaVersion,
    captureId: capture.captureId,
    manifestPath,
    counts: { ...capture.counts },
    coverage: {
      ...capture.coverage,
      roots: capture.coverage.roots.map((root) => ({ ...root })),
      excludes: [...capture.coverage.excludes],
      warnings: [...capture.coverage.warnings],
      issues: capture.coverage.issues.map((issue) => ({ ...issue })),
      limits: { ...capture.coverage.limits }
    },
    changes: capture.changes.map((change) => ({
      rootId: change.rootId,
      root: change.root,
      path: change.path,
      absolutePath: change.absolutePath,
      status: change.status,
      kind: change.kind,
      redacted: change.redacted,
      contentOmitted: change.contentOmitted,
      ...(change.contentOmittedReason ? { contentOmittedReason: change.contentOmittedReason } : {}),
      before: change.before ? { ...change.before } : null,
      after: change.after ? { ...change.after } : null
    }))
  };
}

function addCaptureWarning(capture: FileChangeCapture, warning: string): FileChangeCapture {
  const warnings = stableUnique([...capture.coverage.warnings, warning]);
  return { ...capture, coverage: { ...capture.coverage, status: "partial", partial: true, reason: capture.coverage.reason ?? warning, warnings } };
}

function resolveChangeKind(before: SnapshotFile | null, after: SnapshotFile | null): FileContentKind {
  if (!before) return after?.kind ?? "other";
  if (!after) return before.kind;
  return before.kind === after.kind ? before.kind : "other";
}

function utf8Content(content: Buffer, limit: number): Utf8FileContent {
  return { encoding: "utf-8", text: decodeUtf8Prefix(content, limit), byteSize: content.byteLength, truncated: content.byteLength > limit };
}

function imageContent(file: SnapshotFile, content: Buffer): ImageFileContent {
  return { mediaType: file.mediaType ?? "application/octet-stream", base64: content.toString("base64") };
}

function decodeUtf8Prefix(content: Buffer, limit: number): string {
  if (content.byteLength <= limit) return content.toString("utf8");
  let end = limit;
  while (end > 0 && (content[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return content.subarray(0, end).toString("utf8");
}

function countChanges(changes: FileChange[]): FileChangeCounts {
  return changes.reduce((counts, change) => ({ ...counts, [change.status]: counts[change.status] + 1, total: counts.total + 1 }), { added: 0, modified: 0, deleted: 0, total: 0 });
}

function createCaptureId(startedAt: string, capturedAt: string, changes: FileChange[]): string {
  const digest = createHash("sha256").update(JSON.stringify({ startedAt, capturedAt, changes: changes.map((change) => [change.absolutePath, change.status, change.before?.sha256, change.after?.sha256]) })).digest("hex").slice(0, 24);
  return `fc_${digest}`;
}

async function canonicalizePotentialPath(candidate: string, warnings: string[], label: string): Promise<string> {
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      const physical = await realpath(cursor);
      return path.resolve(physical, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`Could not resolve ${label} ${candidate}: ${errorMessage(error)}`);
        return path.resolve(candidate);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(candidate);
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    const stats = await lstat(value);
    return stats.isFile() || stats.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}

function emptySnapshot(): RootSnapshot {
  return { files: new Map(), complete: true, issues: [], capturedContentBytes: 0 };
}

function rootId(identity: string): string {
  return `root_${createHash("sha256").update(normalizePathForIdentity(identity)).digest("hex").slice(0, 16)}`;
}

function normalizePathForIdentity(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveFromCwd(value: string, cwd: string): string {
  return path.resolve(cwd, value);
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function compareChanges(left: FileChange, right: FileChange): number {
  return stableCompare(left.absolutePath, right.absolutePath) || stableCompare(left.status, right.status);
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCoverageIssues(left: FileChangeCoverageIssue, right: FileChangeCoverageIssue): number {
  return stableCompare(left.root, right.root) || stableCompare(left.path ?? "", right.path ?? "") || stableCompare(left.code, right.code);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
