import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Awaitable<T> = T | Promise<T>;

export type PermissionMode = "ask" | "full-access";

export type PermissionPathFlavor = "native" | "posix";

export type PermissionTarget = "local" | "ssh";

export type PermissionToolName = "bash" | "write" | "edit";

export type PermissionApprovalDecision = "allow-once" | "deny";

export type PermissionApprovalReason =
  | "bash"
  | "outside-project"
  | "no-project"
  | "canonicalization-failed";

/**
 * Trusted execution scope supplied by the host. Never derive projectRoot from
 * an LLM tool argument. A null projectRoot deliberately means every mutation
 * needs approval.
 */
export interface PermissionScope {
  projectRoot: string | null;
  cwd?: string;
  pathFlavor?: PermissionPathFlavor;
  target?: PermissionTarget;
  label?: string;
}

export interface ResolvedPermissionScope {
  projectRoot: string | null;
  cwd: string;
  pathFlavor: PermissionPathFlavor;
  target: PermissionTarget;
  label?: string;
}

export interface CanonicalPathRequest {
  path: string;
  kind: "project-root" | "tool-target";
  scope: ResolvedPermissionScope;
  toolName: "write" | "edit";
}

export type CanonicalPathResolver = (
  request: CanonicalPathRequest
) => Awaitable<string>;

export interface PermissionApprovalRequest {
  toolCallId: string;
  toolName: PermissionToolName;
  reason: PermissionApprovalReason;
  /** Control-character-safe, length-bounded text intended for UI display. */
  summary: string;
  target: PermissionTarget;
  /** Control-character-safe host label for display, when supplied. */
  targetLabel?: string;
  /** Raw trusted host paths for policy/audit code; prefer summary for display. */
  cwd: string;
  projectRoot: string | null;
  /** Raw command for policy/audit code. Do not render without sanitizing. */
  command?: string;
  /** Raw tool path for policy/audit code. Do not render without sanitizing. */
  path?: string;
  /** Lexically resolved tool path when available. */
  resolvedPath?: string;
}

export type PermissionApprovalHandler = (
  request: Readonly<PermissionApprovalRequest>,
  signal: AbortSignal | undefined
) => Awaitable<PermissionApprovalDecision>;

export interface PermissionGateOptions {
  getMode?(ctx: ExtensionContext): Awaitable<PermissionMode>;
  getScope?(ctx: ExtensionContext): Awaitable<PermissionScope>;
  requestApproval?: PermissionApprovalHandler;
  /** Required for POSIX/remote scopes; injectable for deterministic tests. */
  canonicalizePath?: CanonicalPathResolver;
}
