export type PermissionMode = "ask" | "full-access";

export type PermissionToolName = "bash" | "edit" | "write";

export type PermissionApprovalReason =
  | "bash"
  | "outside-project"
  | "no-project"
  | "canonicalization-failed";

export type PermissionApprovalPrompt = {
  id: string;
  threadId: string;
  toolCallId: string;
  toolName: PermissionToolName;
  reason: PermissionApprovalReason;
  summary: string;
  cwd: string;
  projectRoot: string | null;
  command?: string;
  path?: string;
  resolvedPath?: string;
};

export type PermissionApprovalDecision = "allow-once" | "deny";

export type PermissionApprovalResponse = {
  id: string;
  decision: PermissionApprovalDecision;
};
