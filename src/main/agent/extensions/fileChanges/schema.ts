export const FILE_CHANGES_SCHEMA_VERSION = 1 as const;
export const FILE_CHANGES_ENTRY_TYPE = "pi-file-changes";

export const FILE_CHANGES_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.pi/file-changes/**"
] as const;

export const DEFAULT_TEXT_BYTE_LIMIT = 256 * 1024;
export const DEFAULT_DIFF_BYTE_LIMIT = 512 * 1024;
export const DEFAULT_MAX_CONTENT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_RUN_CAPTURED_CONTENT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_MANAGED_TARGETS = 128;
export const DEFAULT_MAX_CHANGES = 10_000;

export type FileChangeTrackingMode = "managed-tools-only" | "watcher";
export type FileChangeStatus = "added" | "modified" | "deleted";
export type FileContentKind = "text" | "image" | "other";
export type CoverageRootSource = "write-target" | "watcher";
export type CoverageRootScope = "file" | "watcher";

export interface FileVersionMetadata {
  sha256: string;
  size: number;
  mode: string;
}

export interface Utf8FileContent {
  encoding: "utf-8";
  text: string;
  byteSize: number;
  truncated: boolean;
}

export interface UnifiedFileDiff {
  format: "unified";
  text: string;
  byteSize: number;
  truncated: boolean;
}

export interface ImageFileContent {
  mediaType: string;
  base64: string;
}

export interface TextFileRepresentation {
  before: Utf8FileContent | null;
  after: Utf8FileContent | null;
  unifiedDiff?: UnifiedFileDiff;
}

export interface ImageFileRepresentation {
  before: ImageFileContent | null;
  after: ImageFileContent | null;
}

export interface FileChange {
  rootId: string;
  root: string;
  path: string;
  absolutePath: string;
  status: FileChangeStatus;
  kind: FileContentKind;
  redacted: boolean;
  contentOmitted: boolean;
  contentOmittedReason?: "max-content-bytes" | "max-captured-content-bytes" | "max-run-captured-content-bytes";
  before: FileVersionMetadata | null;
  after: FileVersionMetadata | null;
  text?: TextFileRepresentation;
  image?: ImageFileRepresentation;
}

export interface FileChangeCoverageRoot {
  id: string;
  path: string;
  physicalPath: string;
  source: CoverageRootSource;
  scope: CoverageRootScope;
  filePath?: string;
  requestedPath?: string;
  /** @deprecated Use requestedPath. Retained for v0.1 host compatibility. */
  requestedFilePath?: string;
  bashCovered: boolean;
}

export interface FileChangeCoverageIssue {
  code: "max-managed-targets" | "max-changes" | "read-error" | "watcher-unavailable" | "excluded-root";
  stage: "baseline" | "final";
  rootId: string;
  root: string;
  path?: string;
  message: string;
}

export interface FileChangeCoverageLimits {
  maxContentBytes: number;
  maxRunCapturedContentBytes: number;
  maxManagedTargets: number;
  maxChanges: number;
  appliesPerObservedFile: true;
}

export interface FileChangeCoverage {
  status: "complete" | "partial" | "failed";
  reason?: string;
  roots: FileChangeCoverageRoot[];
  excludes: string[];
  warnings: string[];
  omittedWarningCount: number;
  partial: boolean;
  issues: FileChangeCoverageIssue[];
  omittedIssueCount: number;
  limits: FileChangeCoverageLimits;
  trackingMode: FileChangeTrackingMode;
  bashCoverage: "not-tracked" | "watcher-observed";
  bashInvoked: boolean;
}

export interface FileChangeCounts {
  added: number;
  modified: number;
  deleted: number;
  total: number;
}

export interface FileChangeCapture {
  schemaVersion: typeof FILE_CHANGES_SCHEMA_VERSION;
  captureId: string;
  startedAt: string;
  capturedAt: string;
  coverage: FileChangeCoverage;
  counts: FileChangeCounts;
  changes: FileChange[];
}

export interface CompactFileChange {
  rootId: string;
  root: string;
  path: string;
  absolutePath: string;
  status: FileChangeStatus;
  kind: FileContentKind;
  redacted: boolean;
  contentOmitted: boolean;
  contentOmittedReason?: FileChange["contentOmittedReason"];
  before: FileVersionMetadata | null;
  after: FileVersionMetadata | null;
}

/**
 * Session entry payload. It intentionally contains metadata only: no source
 * text, unified diff, or image base64 is ever appended to the Pi session.
 */
export interface FileChangeEntry {
  schemaVersion: typeof FILE_CHANGES_SCHEMA_VERSION;
  captureId: string;
  manifestPath: string | null;
  counts: FileChangeCounts;
  coverage: FileChangeCoverage;
  changes: CompactFileChange[];
}
