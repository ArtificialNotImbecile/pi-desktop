import { z } from "zod";

export const permissionModeSchema = z.enum(["ask", "full-access"]);

export const permissionApprovalResponseSchema = z.object({
  id: z.string().trim().min(1).max(200),
  decision: z.enum(["allow-once", "deny"])
});
