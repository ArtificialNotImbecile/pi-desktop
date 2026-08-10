import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolCallEvent,
  type ToolCallEventResult
} from "@earendil-works/pi-coding-agent";
import {
  bashApprovalSummary,
  fileApprovalSummary,
  sanitizePermissionDisplay
} from "./display.js";
import { checkPathScope, resolveToolPath } from "./pathScope.js";
import type {
  PermissionApprovalDecision,
  PermissionApprovalReason,
  PermissionApprovalRequest,
  PermissionGateOptions,
  PermissionMode,
  PermissionScope,
  PermissionToolName,
  ResolvedPermissionScope
} from "./types.js";

export {
  bashApprovalSummary,
  fileApprovalSummary,
  sanitizePermissionDisplay
} from "./display.js";
export {
  canonicalizeLocalPath,
  checkPathScope,
  isPathContained,
  pathApiForFlavor,
  resolveToolPath
} from "./pathScope.js";
export type {
  Awaitable,
  CanonicalPathRequest,
  CanonicalPathResolver,
  PermissionApprovalDecision,
  PermissionApprovalHandler,
  PermissionApprovalReason,
  PermissionApprovalRequest,
  PermissionGateOptions,
  PermissionMode,
  PermissionPathFlavor,
  PermissionScope,
  PermissionTarget,
  PermissionToolName,
  ResolvedPermissionScope
} from "./types.js";

const MODE_FLAG = "permission-mode";
const ALLOW_ONCE_LABEL = "Allow once";
const DENY_LABEL = "Deny";

/** Default Pi CLI entrypoint, discovered through package.json pi.extensions. */
export default function permissionGateExtension(pi: ExtensionAPI): void {
  registerPermissionGate(pi, {});
}

/** Injectable factory for Jasmine and other SDK hosts. */
export function createPermissionGateExtension(options: PermissionGateOptions = {}): ExtensionFactory {
  return (pi) => {
    registerPermissionGate(pi, options);
  };
}

/** Explicitly named alias for the Jasmine host integration. */
export const createJasminePermissionGateExtension = createPermissionGateExtension;

export function registerPermissionGate(
  pi: Pick<ExtensionAPI, "getFlag" | "on" | "registerFlag">,
  options: PermissionGateOptions = {}
): void {
  pi.registerFlag(MODE_FLAG, {
    type: "string",
    default: "ask",
    description: "Permission mode: ask or full-access"
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isGuardedTool(event)) return undefined;

    const mode = await readMode(pi, options, ctx);
    if (!mode.ok) return block(mode.reason);
    if (mode.value === "full-access") return undefined;

    const scopeResult = await readScope(options, ctx);
    if (!scopeResult.ok) return block(scopeResult.reason);
    const scope = scopeResult.value;

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;
      if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
        return block("Permission gate blocked a malformed bash command.");
      }
      return requestDecision(options, ctx, {
        toolCallId: event.toolCallId,
        toolName: "bash",
        reason: "bash",
        summary: bashApprovalSummary(command),
        target: scope.target,
        targetLabel: scope.label,
        cwd: scope.cwd,
        projectRoot: scope.projectRoot,
        command
      });
    }

    const toolName: "write" | "edit" = isToolCallEventType("write", event)
      ? "write"
      : "edit";
    const rawPath = event.input.path;
    if (typeof rawPath !== "string" || rawPath.trim().length === 0 || rawPath.includes("\0")) {
      return block(`Permission gate blocked a malformed ${toolName} path.`);
    }

    let resolvedPath: string;
    try {
      resolvedPath = resolveToolPath(rawPath, scope);
    } catch {
      return block(`Permission gate could not safely resolve the ${toolName} path.`);
    }

    if (scope.projectRoot === null) {
      return requestFileDecision(
        options,
        ctx,
        event.toolCallId,
        toolName,
        rawPath,
        resolvedPath,
        scope,
        "no-project"
      );
    }

    const scopeCheck = await checkPathScope({
      rawPath,
      toolName,
      scope,
      canonicalizePath: options.canonicalizePath
    });
    if (scopeCheck.status === "inside") return undefined;

    return requestFileDecision(
      options,
      ctx,
      event.toolCallId,
      toolName,
      rawPath,
      scopeCheck.resolvedPath,
      scope,
      scopeCheck.status === "outside" ? "outside-project" : "canonicalization-failed"
    );
  });
}

function isGuardedTool(event: ToolCallEvent): boolean {
  return isToolCallEventType("bash", event) ||
    isToolCallEventType("write", event) ||
    isToolCallEventType("edit", event);
}

async function readMode(
  pi: Pick<ExtensionAPI, "getFlag">,
  options: PermissionGateOptions,
  ctx: ExtensionContext
): Promise<{ ok: true; value: PermissionMode } | { ok: false; reason: string }> {
  try {
    const value = options.getMode
      ? await options.getMode(ctx)
      : pi.getFlag(MODE_FLAG);
    if (value === "ask" || value === "full-access") {
      return { ok: true, value };
    }
    return {
      ok: false,
      reason: "Permission gate blocked the tool because the permission mode is invalid."
    };
  } catch {
    return {
      ok: false,
      reason: "Permission gate blocked the tool because the permission mode could not be read."
    };
  }
}

async function readScope(
  options: PermissionGateOptions,
  ctx: ExtensionContext
): Promise<{ ok: true; value: ResolvedPermissionScope } | { ok: false; reason: string }> {
  try {
    const supplied: PermissionScope = options.getScope
      ? await options.getScope(ctx)
      : { projectRoot: ctx.cwd, cwd: ctx.cwd, pathFlavor: "native", target: "local" };
    if (!supplied || (supplied.projectRoot !== null && typeof supplied.projectRoot !== "string")) {
      throw new TypeError("Invalid projectRoot");
    }
    const cwd = typeof supplied.cwd === "string" && supplied.cwd.length > 0
      ? supplied.cwd
      : supplied.projectRoot ?? ctx.cwd;
    if (!cwd || cwd.includes("\0") || supplied.projectRoot?.includes("\0")) {
      throw new TypeError("Invalid cwd");
    }
    if (supplied.pathFlavor !== undefined && supplied.pathFlavor !== "native" && supplied.pathFlavor !== "posix") {
      throw new TypeError("Invalid path flavor");
    }
    if (supplied.target !== undefined && supplied.target !== "local" && supplied.target !== "ssh") {
      throw new TypeError("Invalid target");
    }
    if (supplied.label !== undefined && typeof supplied.label !== "string") {
      throw new TypeError("Invalid target label");
    }
    return {
      ok: true,
      value: {
        projectRoot: supplied.projectRoot,
        cwd,
        pathFlavor: supplied.pathFlavor ?? "native",
        target: supplied.target ?? "local",
        label: supplied.label === undefined
          ? undefined
          : sanitizePermissionDisplay(supplied.label, 256)
      }
    };
  } catch {
    return {
      ok: false,
      reason: "Permission gate blocked the tool because its trusted execution scope could not be read."
    };
  }
}

function requestFileDecision(
  options: PermissionGateOptions,
  ctx: ExtensionContext,
  toolCallId: string,
  toolName: "write" | "edit",
  rawPath: string,
  resolvedPath: string,
  scope: ResolvedPermissionScope,
  reason: Exclude<PermissionApprovalReason, "bash">
): Promise<ToolCallEventResult | undefined> {
  return requestDecision(options, ctx, {
    toolCallId,
    toolName,
    reason,
    summary: fileApprovalSummary(toolName, rawPath, reason),
    target: scope.target,
    targetLabel: scope.label,
    cwd: scope.cwd,
    projectRoot: scope.projectRoot,
    path: rawPath,
    resolvedPath
  });
}

async function requestDecision(
  options: PermissionGateOptions,
  ctx: ExtensionContext,
  request: PermissionApprovalRequest
): Promise<ToolCallEventResult | undefined> {
  let decision: PermissionApprovalDecision | undefined;
  try {
    if (options.requestApproval) {
      decision = await options.requestApproval(Object.freeze({ ...request }), ctx.signal);
    } else if (ctx.hasUI) {
      const selection = await ctx.ui.select(
        `Permission required\n${request.summary}`,
        [ALLOW_ONCE_LABEL, DENY_LABEL],
        { signal: ctx.signal }
      );
      decision = selection === ALLOW_ONCE_LABEL ? "allow-once" : "deny";
    } else {
      return block("Permission denied: approval is required, but no interactive UI is available.");
    }
  } catch {
    return block("Permission denied because the approval request failed or was cancelled.");
  }

  if (decision === "allow-once") return undefined;
  if (decision === "deny") {
    return block(`Permission denied for ${request.toolName}: ${request.summary}`);
  }
  return block("Permission denied because the approval handler returned an invalid decision.");
}

function block(reason: string): ToolCallEventResult {
  return { block: true, reason: sanitizePermissionDisplay(reason) };
}
