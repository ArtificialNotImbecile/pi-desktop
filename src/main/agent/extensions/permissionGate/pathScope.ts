import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  CanonicalPathResolver,
  PermissionPathFlavor,
  ResolvedPermissionScope
} from "./types.js";

type PathApi = typeof path.win32 | typeof path.posix;

export interface PathScopeCheckInput {
  rawPath: string;
  toolName: "write" | "edit";
  scope: ResolvedPermissionScope;
  canonicalizePath?: CanonicalPathResolver;
}

export type PathScopeCheck =
  | {
      status: "inside";
      resolvedPath: string;
      canonicalPath: string;
      canonicalProjectRoot: string;
    }
  | {
      status: "outside";
      resolvedPath: string;
      canonicalPath?: string;
      canonicalProjectRoot?: string;
    }
  | {
      status: "canonicalization-failed";
      resolvedPath: string;
    };

export function pathApiForFlavor(flavor: PermissionPathFlavor): PathApi {
  return flavor === "posix" ? path.posix : path;
}

export function resolveToolPath(rawPath: string, scope: ResolvedPermissionScope): string {
  const pathApi = pathApiForFlavor(scope.pathFlavor);
  const base = pathApi.isAbsolute(scope.cwd)
    ? scope.cwd
    : scope.projectRoot ?? scope.cwd;
  return pathApi.resolve(base, rawPath);
}

export function isPathContained(
  projectRoot: string,
  targetPath: string,
  flavor: PermissionPathFlavor
): boolean {
  const pathApi = pathApiForFlavor(flavor);
  const relative = pathApi.relative(projectRoot, targetPath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

/**
 * Resolve symlinks for an existing path. For a not-yet-created target, resolve
 * the nearest existing ancestor and append the missing suffix.
 */
export async function canonicalizeLocalPath(inputPath: string): Promise<string> {
  const absolutePath = path.resolve(inputPath);
  const missingSegments: string[] = [];
  let cursor = absolutePath;

  for (;;) {
    try {
      await lstat(cursor);
      const canonicalAncestor = await realpath(cursor);
      return path.resolve(canonicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function checkPathScope(input: PathScopeCheckInput): Promise<PathScopeCheck> {
  const { rawPath, scope, toolName } = input;
  const pathApi = pathApiForFlavor(scope.pathFlavor);
  const projectRoot = scope.projectRoot;
  const resolvedPath = resolveToolPath(rawPath, scope);

  if (!projectRoot || !pathApi.isAbsolute(projectRoot)) {
    return { status: "canonicalization-failed", resolvedPath };
  }

  const normalizedProjectRoot = pathApi.resolve(projectRoot);
  if (!isPathContained(normalizedProjectRoot, resolvedPath, scope.pathFlavor)) {
    return { status: "outside", resolvedPath };
  }

  const resolver = input.canonicalizePath ?? (
    scope.pathFlavor === "native" && scope.target === "local"
      ? async ({ path: candidate }: { path: string }) => canonicalizeLocalPath(candidate)
      : undefined
  );
  if (!resolver) return { status: "canonicalization-failed", resolvedPath };

  try {
    const canonicalProjectRoot = await resolver({
      path: normalizedProjectRoot,
      kind: "project-root",
      scope,
      toolName
    });
    const canonicalPath = await resolver({
      path: resolvedPath,
      kind: "tool-target",
      scope,
      toolName
    });

    if (
      typeof canonicalProjectRoot !== "string" ||
      typeof canonicalPath !== "string" ||
      !pathApi.isAbsolute(canonicalProjectRoot) ||
      !pathApi.isAbsolute(canonicalPath)
    ) {
      return { status: "canonicalization-failed", resolvedPath };
    }

    const normalizedCanonicalRoot = pathApi.resolve(canonicalProjectRoot);
    const normalizedCanonicalPath = pathApi.resolve(canonicalPath);
    if (!isPathContained(normalizedCanonicalRoot, normalizedCanonicalPath, scope.pathFlavor)) {
      return {
        status: "outside",
        resolvedPath,
        canonicalPath: normalizedCanonicalPath,
        canonicalProjectRoot: normalizedCanonicalRoot
      };
    }

    return {
      status: "inside",
      resolvedPath,
      canonicalPath: normalizedCanonicalPath,
      canonicalProjectRoot: normalizedCanonicalRoot
    };
  } catch {
    return { status: "canonicalization-failed", resolvedPath };
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
