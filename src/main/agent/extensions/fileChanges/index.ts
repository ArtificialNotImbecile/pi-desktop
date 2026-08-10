import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent
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
  DEFAULT_MAX_CAPTURED_CONTENT_BYTES,
  DEFAULT_MAX_CHANGES,
  DEFAULT_MAX_CONTENT_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_MANAGED_TARGETS,
  DEFAULT_MAX_ROOTS,
  DEFAULT_MAX_RUN_CAPTURED_CONTENT_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_TEXT_BYTE_LIMIT,
  FILE_CHANGES_ENTRY_TYPE,
  FILE_CHANGES_EXCLUDES,
  FILE_CHANGES_SCHEMA_VERSION,
  type CoverageRootSource,
  type CoverageRootScope,
  type FileChange,
  type FileChangeCapture,
  type FileChangeCounts,
  type FileChangeCoverage,
  type FileChangeCoverageIssue,
  type FileChangeCoverageRoot,
  type FileChangeEntry,
  type FileContentKind,
  type ImageFileContent,
  type Utf8FileContent
} from "./schema.js";

const MAX_CAPTURE_WARNINGS = 100;
const MAX_CAPTURE_ISSUES = 100;

export * from "./redaction.js";
export * from "./schema.js";

export interface FileChangeExtensionOptions {
  /** Roots to snapshot at agent_start. When omitted, ctx.cwd is the sole root. */
  roots?: readonly string[] | ((ctx: ExtensionContext) => readonly string[] | Promise<readonly string[]>);
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
  /** Maximum files traversed in each root snapshot. */
  maxFiles?: number;
  /** Maximum total file bytes traversed in each recursive root snapshot. */
  maxTotalBytes?: number;
  /** Maximum raw content retained for one file; metadata is still captured. */
  maxContentBytes?: number;
  /** Maximum raw content retained across one root snapshot. */
  maxCapturedContentBytes?: number;
  /** Maximum raw preview content retained across all snapshots in one run. */
  maxRunCapturedContentBytes?: number;
  /** Maximum recursive plus exact-file roots admitted in one run. */
  maxRoots?: number;
  /** Maximum distinct write/edit targets dynamically baselined in one run. */
  maxManagedTargets?: number;
  /** Maximum changed-file records materialized in one capture. */
  maxChanges?: number;
  /** Adds host-specific sensitive paths to the built-in fail-safe patterns. */
  shouldRedact?: FileRedactionPredicate;
  /** Adds host-specific content redaction; exceptions fail closed. */
  shouldRedactContent?: FileContentRedactionPredicate;
  /** Parent for the external temporary bare Git repository. */
  temporaryDirectory?: string;
}

interface RootState {
  id: string;
  path: string;
  physicalPath: string;
  source: CoverageRootSource;
  scope: CoverageRootScope;
  filePath?: string;
  requestedFilePath?: string;
  bashCovered: boolean;
  baselineOrder: number;
  before: RootSnapshot | null;
}

interface RunState {
  cwd: string;
  startedAt: string;
  repository: SnapshotRepository | null;
  roots: RootState[];
  warnings: string[];
  issues: FileChangeCoverageIssue[];
  failureReason?: string;
  bashInvoked: boolean;
  shouldRedact?: FileRedactionPredicate;
  shouldRedactContent?: FileContentRedactionPredicate;
  limits: {
    maxFiles: number;
    maxTotalBytes: number;
    maxContentBytes: number;
    maxCapturedContentBytes: number;
    maxRunCapturedContentBytes: number;
    maxRoots: number;
    maxManagedTargets: number;
    maxChanges: number;
  };
  capturedContentBytes: number;
  managedTargetCount: number;
  registrationQueue: Promise<void>;
  snapshotSequence: number;
  rootSequence: number;
}

export function createFileChangeExtension(options: FileChangeExtensionOptions = {}): ExtensionFactory {
  const persistManifest = options.persistManifest ?? false;
  const appendEntry = options.appendEntry ?? true;
  const maxTextBytes = positiveInteger(options.maxTextBytes, DEFAULT_TEXT_BYTE_LIMIT);
  const maxDiffBytes = positiveInteger(options.maxDiffBytes, DEFAULT_DIFF_BYTE_LIMIT);
  const limits = {
    maxFiles: positiveInteger(options.maxFiles, DEFAULT_MAX_FILES),
    maxTotalBytes: positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
    maxContentBytes: positiveInteger(options.maxContentBytes, DEFAULT_MAX_CONTENT_BYTES),
    maxCapturedContentBytes: positiveInteger(options.maxCapturedContentBytes, DEFAULT_MAX_CAPTURED_CONTENT_BYTES),
    maxRunCapturedContentBytes: positiveInteger(options.maxRunCapturedContentBytes, DEFAULT_MAX_RUN_CAPTURED_CONTENT_BYTES),
    maxRoots: positiveInteger(options.maxRoots, DEFAULT_MAX_ROOTS),
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
      run.registrationQueue = run.registrationQueue.then(async () => {
        await registerWriteTarget(run, event, ctx, options);
      });
      await run.registrationQueue;
    });

    pi.on("agent_settled", async (_event, ctx) => {
      const run = activeRun;
      activeRun = null;
      if (!run) return;

      let callbackError: unknown;
      try {
        await run.registrationQueue;
        let capture = await finishRun(run, maxTextBytes, maxDiffBytes);
        let manifestPath: string | null = null;

        if (run.repository) {
          const repository = run.repository;
          try {
            await removeSnapshotRepository(repository);
            run.repository = null;
          } catch (error) {
            const warning = `Could not clean up temporary file-change repository ${repository.directory}: ${errorMessage(error)}`;
            console.warn(warning);
            capture = addCaptureWarning(capture, warning);
          }
        }

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

        if (appendEntry) {
          pi.appendEntry(FILE_CHANGES_ENTRY_TYPE, compactEntry(capture, manifestPath));
        }
      } finally {
        if (run.repository) {
          const repository = run.repository;
          try {
            await removeSnapshotRepository(repository);
            run.repository = null;
          } catch (error) {
            console.warn(`Temporary file-change repository remains at ${repository.directory}: ${errorMessage(error)}`);
          }
        }
      }
      if (callbackError) throw callbackError;
    });

    pi.on("session_shutdown", async () => {
      const run = activeRun;
      activeRun = null;
      if (run?.repository) {
        const repository = run.repository;
        try {
          await removeSnapshotRepository(repository);
          run.repository = null;
        } catch (error) {
          console.warn(`Temporary file-change repository remains at ${repository.directory}: ${errorMessage(error)}`);
        }
      }
    });
  };
}

/** Default Pi CLI entrypoint discovered through package.json pi.extensions. */
export default function fileChanges(pi: ExtensionAPI): void {
  const manifestDirectory = process.env.PI_FILE_CHANGES_MANIFEST_DIR?.trim();
  if (manifestDirectory && path.isAbsolute(manifestDirectory)) {
    createFileChangeExtension({
      persistManifest: true,
      manifestDirectory,
      requireExternalManifestDirectory: true
    })(pi);
    return;
  }
  if (manifestDirectory) {
    console.warn("PI_FILE_CHANGES_MANIFEST_DIR must be an absolute external directory; full manifests remain disabled.");
  }
  createFileChangeExtension()(pi);
}

async function beginRun(
  ctx: ExtensionContext,
  options: FileChangeExtensionOptions,
  limits: RunState["limits"]
): Promise<RunState> {
  const cwd = path.resolve(ctx.cwd);
  const warnings: string[] = [];
  const startedAt = new Date().toISOString();
  const run: RunState = {
    cwd,
    startedAt,
    repository: null,
    roots: [],
    warnings,
    issues: [],
    bashInvoked: false,
    shouldRedact: options.shouldRedact,
    shouldRedactContent: options.shouldRedactContent,
    limits,
    capturedContentBytes: 0,
    managedTargetCount: 0,
    registrationQueue: Promise.resolve(),
    snapshotSequence: 0,
    rootSequence: 0
  };

  let temporaryRunDirectory: string | null = null;
  try {
    const temporaryParent = path.resolve(options.temporaryDirectory ?? tmpdir());
    await mkdir(temporaryParent, { recursive: true });
    temporaryRunDirectory = await mkdtemp(path.join(temporaryParent, "pi-file-changes-"));
    run.repository = await initializeSnapshotRepository(temporaryRunDirectory);
  } catch (error) {
    const failure = `Could not initialize external Git snapshot repository: ${errorMessage(error)}`;
    run.failureReason = failure;
    warnings.push(failure);
    if (temporaryRunDirectory) {
      try {
        await rm(temporaryRunDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        const warning = `Could not clean up failed file-change repository ${temporaryRunDirectory}: ${errorMessage(cleanupError)}`;
        warnings.push(warning);
        console.warn(warning);
      }
    }
  }

  let configuredRoots: readonly string[];
  try {
    configuredRoots = options.roots === undefined
      ? [cwd]
      : typeof options.roots === "function"
        ? await options.roots(ctx)
        : options.roots;
  } catch (error) {
    configuredRoots = [];
    warnings.push(`Could not resolve configured file-change roots: ${errorMessage(error)}`);
  }

  const source: CoverageRootSource = options.roots === undefined ? "cwd" : "configured";
  const normalized = collapseRoots(configuredRoots.map((root) => resolveFromCwd(root, cwd)));
  for (const root of normalized) {
    if (run.roots.length >= run.limits.maxRoots) {
      recordRunLimit(run, "max-roots", root, "baseline", `Maximum root count ${run.limits.maxRoots} reached; remaining configured roots were not observed.`);
      break;
    }
    await addRoot(run, root, source, true);
  }
  return run;
}

async function registerWriteTarget(
  run: RunState,
  event: ToolCallEvent,
  ctx: ExtensionContext,
  options: FileChangeExtensionOptions
): Promise<void> {
  const input = event.input as Record<string, unknown>;
  const rawPath = typeof input.path === "string" ? input.path.trim() : "";
  if (!rawPath) {
    run.warnings.push(`${event.toolName} call ${event.toolCallId} did not expose a usable path.`);
    return;
  }
  const requestedPath = resolveFromCwd(rawPath, ctx.cwd);
  const canonicalPath = await canonicalizePotentialPath(requestedPath, run.warnings, "managed file target");
  if (isCoveredByExactFile(run.roots, canonicalPath)) return;
  if (isExcludedAbsolutePath(requestedPath) || isExcludedAbsolutePath(canonicalPath)) {
    run.warnings.push(`Write target is excluded by file-change policy: ${canonicalPath}`);
    return;
  }
  if (run.managedTargetCount >= run.limits.maxManagedTargets) {
    recordRunLimit(run, "max-managed-targets", canonicalPath, "baseline", `Maximum managed write/edit target count ${run.limits.maxManagedTargets} reached; additional targets were not observed.`);
    return;
  }
  if (run.roots.length >= run.limits.maxRoots) {
    recordRunLimit(run, "max-roots", canonicalPath, "baseline", `Maximum root count ${run.limits.maxRoots} reached; the managed target was not observed.`);
    return;
  }
  await addFileRoot(run, requestedPath, canonicalPath);
}

async function addRoot(
  run: RunState,
  root: string,
  source: CoverageRootSource,
  bashCovered: boolean
): Promise<void> {
  const logicalPath = path.resolve(root);
  let physicalPath = logicalPath;
  try {
    physicalPath = await realpath(logicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      physicalPath = await canonicalizePotentialPath(logicalPath, run.warnings, "configured root");
    } else {
      run.warnings.push(`Could not resolve file-change root ${logicalPath}: ${errorMessage(error)}`);
    }
  }
  if (isCoveredByRoot(run.roots, physicalPath)) return;
  const state: RootState = {
    id: rootId(`recursive\0${physicalPath}`),
    path: logicalPath,
    physicalPath,
    source,
    scope: "recursive",
    bashCovered,
    baselineOrder: run.rootSequence++,
    before: null
  };
  run.roots.push(state);
  run.roots.sort(compareRootState);

  if (!run.repository) return;
  try {
    state.before = await snapshotForRun(run, physicalPath, `before-${run.snapshotSequence++}`);
    recordSnapshotIssues(run, state, state.before, "baseline");
  } catch (error) {
    run.warnings.push(`Could not create baseline for ${logicalPath}: ${errorMessage(error)}`);
  }
}

async function addFileRoot(
  run: RunState,
  requestedFilePath: string,
  canonicalFilePath: string
): Promise<void> {
  if (isCoveredByExactFile(run.roots, canonicalFilePath)) return;
  const physicalPath = path.dirname(canonicalFilePath);
  const state: RootState = {
    id: rootId(`file\0${canonicalFilePath}`),
    path: physicalPath,
    physicalPath,
    source: "write-target",
    scope: "file",
    filePath: canonicalFilePath,
    requestedFilePath,
    bashCovered: false,
    baselineOrder: run.rootSequence++,
    before: null
  };
  run.roots.push(state);
  run.managedTargetCount += 1;
  run.roots.sort(compareRootState);
  if (!run.repository) return;
  try {
    state.before = await snapshotForRun(
      run,
      physicalPath,
      `before-${run.snapshotSequence++}`,
      [path.basename(canonicalFilePath)]
    );
    recordSnapshotIssues(run, state, state.before, "baseline");
  } catch (error) {
    run.warnings.push(`Could not create exact-file baseline for ${canonicalFilePath}: ${errorMessage(error)}`);
  }
}

async function snapshotForRun(
  run: RunState,
  root: string,
  indexName: string,
  includeRelativePaths?: readonly string[]
): Promise<RootSnapshot> {
  if (!run.repository) throw new Error("Snapshot repository is unavailable.");
  const remainingRunContentBytes = Math.max(
    0,
    run.limits.maxRunCapturedContentBytes - run.capturedContentBytes
  );
  const maxCapturedContentBytes = Math.min(
    run.limits.maxCapturedContentBytes,
    remainingRunContentBytes
  );
  const snapshot = await snapshotRoot(run.repository, root, {
    indexName,
    shouldRedact: run.shouldRedact,
    shouldRedactContent: run.shouldRedactContent,
    ...(includeRelativePaths ? { includeRelativePaths } : {}),
    maxFiles: run.limits.maxFiles,
    maxTotalBytes: run.limits.maxTotalBytes,
    maxContentBytes: run.limits.maxContentBytes,
    maxCapturedContentBytes,
    ...(remainingRunContentBytes < run.limits.maxCapturedContentBytes
      ? {
          capturedContentIssueCode: "max-run-captured-content-bytes" as const,
          capturedContentIssueLimit: run.limits.maxRunCapturedContentBytes
        }
      : {}),
    warnings: run.warnings
  });
  run.capturedContentBytes += snapshot.capturedContentBytes;
  return snapshot;
}

async function finishRun(
  run: RunState,
  maxTextBytes: number,
  maxDiffBytes: number
): Promise<FileChangeCapture> {
  const changes: FileChange[] = [];
  if (run.repository) {
    const orderedRoots = [...run.roots].sort(compareRootState);
    const recursiveRoots = orderedRoots.filter((root) => root.scope === "recursive" && root.before);
    const exactRoots = orderedRoots.filter((root) => root.scope === "file" && root.before);
    const recursiveAfter = new Map<string, RootSnapshot>();
    const materializedRecursiveRoots = new Set<string>();
    let changeLimitReached = false;

    // Exact roots can only be skipped after the final recursive evidence is
    // known, so snapshot all recursive roots first.
    for (const root of recursiveRoots) {
      try {
        const after = await snapshotForRun(
          run,
          root.physicalPath,
          `after-${run.snapshotSequence++}`
        );
        recordSnapshotIssues(run, root, after, "final");
        recursiveAfter.set(root.id, after);
      } catch (error) {
        run.warnings.push(`Could not create final snapshot for ${root.path}: ${errorMessage(error)}`);
      }
    }

    for (const root of recursiveRoots) {
      const after = recursiveAfter.get(root.id);
      if (!root.before || !after) continue;
      if (changes.length >= run.limits.maxChanges) {
        recordRunLimit(run, "max-changes", root.path, "final", `Maximum captured change count ${run.limits.maxChanges} reached; remaining changes were not materialized.`);
        changeLimitReached = true;
        break;
      }
      try {
        const materialized = await materializeRootChanges(
          run.repository,
          root,
          root.before,
          after,
          maxTextBytes,
          maxDiffBytes,
          run.limits.maxChanges - changes.length
        );
        changes.push(...materialized.changes);
        materializedRecursiveRoots.add(root.id);
        if (materialized.truncated) {
          recordRunLimit(run, "max-changes", root.path, "final", `Maximum captured change count ${run.limits.maxChanges} reached; remaining changes were not materialized.`);
          changeLimitReached = true;
          break;
        }
      } catch (error) {
        run.warnings.push(`Could not materialize changes for ${root.path}: ${errorMessage(error)}`);
      }
    }

    if (!changeLimitReached) {
      for (const root of exactRoots) {
        if (!root.before || !root.filePath) continue;
        if (exactCoveredByRecursiveEvidence(
          root.filePath,
          recursiveRoots,
          recursiveAfter,
          materializedRecursiveRoots
        )) continue;
        if (changes.length >= run.limits.maxChanges) {
          recordRunLimit(run, "max-changes", root.path, "final", `Maximum captured change count ${run.limits.maxChanges} reached; remaining changes were not materialized.`);
          break;
        }
        try {
          const relativePath = path.relative(root.physicalPath, root.filePath).replace(/\\/g, "/");
          const after = await snapshotForRun(
            run,
            root.physicalPath,
            `after-${run.snapshotSequence++}`,
            [relativePath]
          );
          recordSnapshotIssues(run, root, after, "final");
          const materialized = await materializeRootChanges(
            run.repository,
            root,
            root.before,
            after,
            maxTextBytes,
            maxDiffBytes,
            run.limits.maxChanges - changes.length
          );
          changes.push(...materialized.changes);
          if (materialized.truncated) {
            recordRunLimit(run, "max-changes", root.path, "final", `Maximum captured change count ${run.limits.maxChanges} reached; remaining changes were not materialized.`);
            break;
          }
        } catch (error) {
          run.warnings.push(`Could not create exact-file final snapshot for ${root.filePath}: ${errorMessage(error)}`);
        }
      }
    }
  }

  const rootsById = new Map(run.roots.map((root) => [root.id, root]));
  const uniqueChanges = new Map<string, FileChange>();
  for (const change of changes) {
    const root = rootsById.get(change.rootId);
    // Compare overlap by canonical physical root + relative path while keeping
    // path casing intact so a case-only move remains delete + add.
    const key = path.resolve(
      root?.physicalPath ?? change.root,
      ...change.path.split("/")
    ).replace(/\\/g, "/");
    const current = uniqueChanges.get(key);
    const currentRoot = current ? rootsById.get(current.rootId) : undefined;
    if (!current || (root?.baselineOrder ?? Number.MAX_SAFE_INTEGER)
      < (currentRoot?.baselineOrder ?? Number.MAX_SAFE_INTEGER)) {
      uniqueChanges.set(key, change);
    }
  }
  changes.splice(0, changes.length, ...uniqueChanges.values());
  changes.sort(compareChanges);
  const capturedAt = new Date().toISOString();
  const coverage = createCoverage(run);
  return {
    schemaVersion: FILE_CHANGES_SCHEMA_VERSION,
    captureId: createCaptureId(run.startedAt, capturedAt, changes),
    startedAt: run.startedAt,
    capturedAt,
    coverage,
    counts: countChanges(changes),
    changes
  };
}

function exactCoveredByRecursiveEvidence(
  filePath: string,
  recursiveRoots: RootState[],
  recursiveAfter: Map<string, RootSnapshot>,
  materializedRecursiveRoots: Set<string>
): boolean {
  for (const root of recursiveRoots) {
    if (!root.before || !materializedRecursiveRoots.has(root.id)) continue;
    const after = recursiveAfter.get(root.id);
    if (!after || !isPathInside(root.physicalPath, filePath)) continue;
    const relativePath = path.relative(root.physicalPath, filePath).replace(/\\/g, "/");
    const beforeKnown = root.before.complete || root.before.files.has(relativePath);
    const afterKnown = after.complete || after.files.has(relativePath);
    if (beforeKnown && afterKnown) return true;
  }
  return false;
}

async function materializeRootChanges(
  repository: SnapshotRepository,
  root: RootState,
  before: RootSnapshot,
  after: RootSnapshot,
  maxTextBytes: number,
  maxDiffBytes: number,
  maxChanges: number
): Promise<{ changes: FileChange[]; truncated: boolean }> {
  const changedPaths = await listChangedPaths(before, after);
  const selected: Array<{
    changed: (typeof changedPaths)[number];
    beforeFile: SnapshotFile | null;
    afterFile: SnapshotFile | null;
    redacted: boolean;
    contentOmitted: boolean;
    contentOmittedReason?: FileChange["contentOmittedReason"];
    contentAvailable: boolean;
    kind: FileContentKind;
  }> = [];
  let truncated = false;
  for (const changed of changedPaths) {
    if (selected.length >= maxChanges) {
      truncated = true;
      break;
    }
    if (changed.status === "added" && !before.complete) continue;
    if (changed.status === "deleted" && !after.complete) continue;
    const beforeFile = before.files.get(changed.path) ?? null;
    const afterFile = after.files.get(changed.path) ?? null;
    const redacted = Boolean(beforeFile?.redacted || afterFile?.redacted);
    const contentOmitted = Boolean(beforeFile?.contentOmitted || afterFile?.contentOmitted);
    const contentOmittedReason = beforeFile?.contentOmittedReason ?? afterFile?.contentOmittedReason;
    const contentAvailable = (!beforeFile || beforeFile.contentAvailable)
      && (!afterFile || afterFile.contentAvailable);
    const kind = resolveChangeKind(beforeFile, afterFile);
    selected.push({
      changed,
      beforeFile,
      afterFile,
      redacted,
      contentOmitted,
      ...(contentOmittedReason ? { contentOmittedReason } : {}),
      contentAvailable,
      kind
    });
  }

  const unifiedDiffs = await createUnifiedDiffs(
    repository,
    selected
      .filter((item) => !item.redacted && !item.contentOmitted && item.contentAvailable && item.kind === "text")
      .map((item) => ({
        path: item.changed.path,
        before: item.beforeFile,
        after: item.afterFile
      })),
    `diff-${root.id}-${root.baselineOrder}`,
    maxDiffBytes
  );

  const changes: FileChange[] = [];
  for (const item of selected) {
    const {
      changed,
      beforeFile,
      afterFile,
      redacted,
      contentOmitted,
      contentOmittedReason,
      contentAvailable,
      kind
    } = item;
    const change: FileChange = {
      rootId: root.id,
      root: root.path,
      path: changed.path,
      absolutePath: path.resolve(root.path, ...changed.path.split("/")),
      status: changed.status,
      kind,
      redacted,
      contentOmitted,
      ...(contentOmittedReason ? { contentOmittedReason } : {}),
      before: beforeFile?.metadata ?? null,
      after: afterFile?.metadata ?? null
    };

    if (!redacted && !contentOmitted && contentAvailable && kind === "text") {
      const beforeContent = beforeFile?.content ?? null;
      const afterContent = afterFile?.content ?? null;
      const unifiedDiff = unifiedDiffs.get(changed.path);
      if (!unifiedDiff) throw new Error(`Missing batched unified diff for ${changed.path}.`);
      change.text = {
        before: beforeContent ? utf8Content(beforeContent, maxTextBytes) : null,
        after: afterContent ? utf8Content(afterContent, maxTextBytes) : null,
        unifiedDiff: {
          format: "unified",
          text: decodeUtf8Prefix(unifiedDiff.buffer, maxDiffBytes),
          byteSize: unifiedDiff.byteSize,
          truncated: unifiedDiff.truncated || unifiedDiff.byteSize > maxDiffBytes
        }
      };
    } else if (!redacted && !contentOmitted && contentAvailable && kind === "image") {
      const beforeContent = beforeFile?.content ?? null;
      const afterContent = afterFile?.content ?? null;
      change.image = {
        before: beforeFile && beforeContent ? imageContent(beforeFile, beforeContent) : null,
        after: afterFile && afterContent ? imageContent(afterFile, afterContent) : null
      };
    }
    changes.push(change);
  }
  return { changes, truncated };
}

function createCoverage(run: RunState): FileChangeCoverage {
  const roots: FileChangeCoverageRoot[] = run.roots
    .map((root) => ({
      id: root.id,
      path: root.path,
      physicalPath: root.physicalPath,
      source: root.source,
      scope: root.scope,
      ...(root.filePath ? { filePath: root.filePath } : {}),
      ...(root.requestedFilePath
        ? { requestedPath: root.requestedFilePath, requestedFilePath: root.requestedFilePath }
        : {}),
      bashCovered: root.bashCovered
    }))
    .sort((left, right) => stableCompare(left.path, right.path)
      || stableCompare(left.filePath ?? "", right.filePath ?? ""));
  const allWarnings = stableUnique(run.warnings);
  const allIssues = [...run.issues].sort(compareCoverageIssues);
  const warnings = allWarnings.slice(0, MAX_CAPTURE_WARNINGS);
  const issues = allIssues.slice(0, MAX_CAPTURE_ISSUES);
  const bashReason = "A bash tool was invoked; only listed agent-start roots were observed and shell changes outside those roots are unobservable.";
  const status: FileChangeCoverage["status"] = run.failureReason
    ? "failed"
    : run.bashInvoked || warnings.length > 0 || issues.length > 0
      ? "partial"
      : "complete";
  const reason = run.failureReason
    ?? (run.bashInvoked ? bashReason : issues[0]?.message ?? warnings[0]);
  return {
    status,
    ...(reason ? { reason } : {}),
    roots,
    excludes: [...FILE_CHANGES_EXCLUDES],
    warnings,
    omittedWarningCount: allWarnings.length - warnings.length,
    partial: status !== "complete",
    issues,
    omittedIssueCount: allIssues.length - issues.length,
    limits: {
      ...run.limits,
      appliesPerRootSnapshot: true
    },
    bashCoverage: "agent-start-roots-only",
    bashInvoked: run.bashInvoked
  };
}

function recordSnapshotIssues(
  run: RunState,
  root: RootState,
  snapshot: RootSnapshot,
  stage: FileChangeCoverageIssue["stage"]
): void {
  for (const issue of snapshot.issues) {
    run.issues.push({
      code: issue.code,
      stage,
      rootId: root.id,
      root: root.path,
      ...(issue.path ? { path: issue.path } : {}),
      message: issue.message
    });
  }
}

function recordRunLimit(
  run: RunState,
  code: "max-roots" | "max-managed-targets" | "max-changes",
  affectedPath: string,
  stage: FileChangeCoverageIssue["stage"],
  message: string
): void {
  if (run.issues.some((issue) => issue.code === code)) return;
  run.issues.push({
    code,
    stage,
    rootId: rootId(`limit\0${code}\0${affectedPath}`),
    root: affectedPath,
    path: affectedPath,
    message
  });
}

async function persistCaptureManifest(
  capture: FileChangeCapture,
  cwd: string,
  configuredDirectory: string | undefined,
  requireExternal: boolean
): Promise<string> {
  const directory = path.resolve(cwd, configuredDirectory ?? path.join(".pi", "file-changes"));
  if (requireExternal && isPathInside(cwd, directory)) {
    throw new Error(`Manifest directory must be outside the working root: ${directory}`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(directory, `${capture.captureId}.json`);
  const temporaryPath = path.join(directory, `.${capture.captureId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(capture, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return manifestPath;
}

function compactEntry(capture: FileChangeCapture, manifestPath: string | null): FileChangeEntry {
  return {
    schemaVersion: FILE_CHANGES_SCHEMA_VERSION,
    captureId: capture.captureId,
    manifestPath,
    counts: { ...capture.counts },
    coverage: {
      status: capture.coverage.status,
      ...(capture.coverage.reason ? { reason: capture.coverage.reason } : {}),
      roots: capture.coverage.roots.map((root) => ({ ...root })),
      excludes: [...capture.coverage.excludes],
      warnings: [...capture.coverage.warnings],
      omittedWarningCount: capture.coverage.omittedWarningCount,
      partial: capture.coverage.partial,
      issues: capture.coverage.issues.map((issue) => ({ ...issue })),
      omittedIssueCount: capture.coverage.omittedIssueCount,
      limits: { ...capture.coverage.limits },
      bashCoverage: capture.coverage.bashCoverage,
      bashInvoked: capture.coverage.bashInvoked
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
  return {
    ...capture,
    coverage: {
      ...capture.coverage,
      status: capture.coverage.status === "failed" ? "failed" : "partial",
      reason: capture.coverage.reason ?? warning,
      partial: true,
      warnings: warnings.slice(0, MAX_CAPTURE_WARNINGS),
      omittedWarningCount: capture.coverage.omittedWarningCount
        + Math.max(0, warnings.length - MAX_CAPTURE_WARNINGS)
    }
  };
}

function resolveChangeKind(before: SnapshotFile | null, after: SnapshotFile | null): FileContentKind {
  const kinds = [before?.kind, after?.kind].filter((kind): kind is FileContentKind => Boolean(kind));
  if (kinds.length > 0 && kinds.every((kind) => kind === "text")) return "text";
  if (kinds.length > 0 && kinds.every((kind) => kind === "image")) return "image";
  return "other";
}

function utf8Content(content: Buffer, limit: number): Utf8FileContent {
  return {
    encoding: "utf-8",
    text: decodeUtf8Prefix(content, limit),
    byteSize: content.byteLength,
    truncated: content.byteLength > limit
  };
}

function imageContent(file: SnapshotFile, content: Buffer): ImageFileContent {
  return {
    mediaType: file.mediaType ?? "application/octet-stream",
    base64: content.toString("base64")
  };
}

function decodeUtf8Prefix(content: Buffer, limit: number): string {
  let end = Math.min(content.byteLength, limit);
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function countChanges(changes: FileChange[]): FileChangeCounts {
  const counts: FileChangeCounts = { added: 0, modified: 0, deleted: 0, total: changes.length };
  for (const change of changes) counts[change.status] += 1;
  return counts;
}

function createCaptureId(startedAt: string, capturedAt: string, changes: FileChange[]): string {
  const digest = createHash("sha256")
    .update(startedAt)
    .update("\0")
    .update(capturedAt)
    .update("\0")
    .update(JSON.stringify(changes.map((change) => [
      change.root,
      change.path,
      change.status,
      change.before?.sha256 ?? null,
      change.after?.sha256 ?? null
    ])))
    .digest("hex")
    .slice(0, 20);
  return `${capturedAt.replace(/[:.]/g, "-")}-${digest}`;
}

function collapseRoots(roots: string[]): string[] {
  const unique = stableUnique(roots.map((root) => path.resolve(root)));
  unique.sort((left, right) => left.length - right.length || stableCompare(left, right));
  const collapsed: string[] = [];
  for (const root of unique) {
    if (!collapsed.some((parent) => isPathInside(parent, root))) collapsed.push(root);
  }
  return collapsed.sort(stableCompare);
}

function isCoveredByRoot(roots: RootState[], target: string): boolean {
  const normalizedTarget = normalizePathForIdentity(target);
  return roots.some((root) => root.scope === "recursive"
    ? isPathInside(root.physicalPath, target)
    : Boolean(root.filePath && normalizePathForIdentity(root.filePath) === normalizedTarget));
}

function isCoveredByExactFile(roots: RootState[], target: string): boolean {
  const normalizedTarget = normalizePathForIdentity(target);
  return roots.some((root) => root.scope === "file"
    && Boolean(root.filePath && normalizePathForIdentity(root.filePath) === normalizedTarget));
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveFromCwd(value: string, cwd: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

async function canonicalizePotentialPath(
  value: string,
  warnings: string[],
  subject: string
): Promise<string> {
  const absolutePath = path.resolve(value);
  let current = absolutePath;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(current);
      return path.resolve(canonicalAncestor, ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        warnings.push(`Could not canonicalize ${subject} ${absolutePath}: ${errorMessage(error)}`);
        return absolutePath;
      }
      const parent = path.dirname(current);
      if (parent === current) return absolutePath;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

function rootId(identity: string): string {
  const normalized = identity.replace(/\\/g, "/");
  return createHash("sha256")
    .update(process.platform === "win32" ? normalized.toLowerCase() : normalized)
    .digest("hex")
    .slice(0, 16);
}

function normalizePathForIdentity(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function compareRootState(left: RootState, right: RootState): number {
  return stableCompare(normalizePathForIdentity(left.physicalPath), normalizePathForIdentity(right.physicalPath))
    || stableCompare(normalizePathForIdentity(left.filePath ?? ""), normalizePathForIdentity(right.filePath ?? ""));
}

function compareChanges(left: FileChange, right: FileChange): number {
  return stableCompare(normalizePathForIdentity(left.root), normalizePathForIdentity(right.root))
    || stableCompare(left.path, right.path);
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(stableCompare);
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCoverageIssues(left: FileChangeCoverageIssue, right: FileChangeCoverageIssue): number {
  return stableCompare(left.root, right.root)
    || stableCompare(left.stage, right.stage)
    || stableCompare(left.code, right.code)
    || stableCompare(left.message, right.message);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
