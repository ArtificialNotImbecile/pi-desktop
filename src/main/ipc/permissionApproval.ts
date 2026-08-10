import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type {
  PermissionApprovalDecision,
  PermissionApprovalPrompt,
  PermissionApprovalResponse
} from "../../shared/permissions.js";
import { permissionApprovalResponseSchema } from "../../shared/permissionSchemas.js";
import { abortError } from "../utils/abort.js";
import type { IpcContext } from "./context.js";

type PendingPermission = {
  sender: WebContents;
  resolve(decision: PermissionApprovalDecision): void;
  reject(error: Error): void;
};

const pendingPermissions = new Map<string, PendingPermission>();

export function registerPermissionApprovalIpc(_context: IpcContext): void {
  ipcMain.handle("permissionApproval:answer", (event, input: PermissionApprovalResponse): void => {
    const response = permissionApprovalResponseSchema.parse(input);
    const pending = pendingPermissions.get(response.id);
    if (!pending) return;
    assertSameSender(event, pending.sender);
    pendingPermissions.delete(response.id);
    pending.resolve(response.decision);
  });
}

export function requestPermissionApprovalInRenderer(
  sender: WebContents,
  prompt: Omit<PermissionApprovalPrompt, "id">,
  signal?: AbortSignal
): Promise<PermissionApprovalDecision> {
  const id = `permission-approval-${crypto.randomUUID()}`;
  const payload: PermissionApprovalPrompt = { ...prompt, id };

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      pendingPermissions.delete(id);
      signal?.removeEventListener("abort", onAbort);
      sender.removeListener("destroyed", onDestroyed);
      sender.removeListener("did-start-navigation", onNavigation);
      sender.removeListener("render-process-gone", onRenderProcessGone);
    };

    const finish = (decision: PermissionApprovalDecision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const cancelRendererPrompt = () => {
      if (sender.isDestroyed()) return;
      try {
        sender.send("permissionApproval:cancelled", id);
      } catch {
        // The renderer can be destroyed between isDestroyed() and send(). The
        // approval still rejects below; cancellation delivery is best effort.
      }
    };

    const onAbort = () => {
      cancelRendererPrompt();
      fail(abortError("Permission approval was cancelled because the response stopped."));
    };

    const onDestroyed = () => {
      fail(new Error("Permission approval failed because the Jasmine window closed."));
    };

    const onNavigation = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (event.isMainFrame && !event.isSameDocument) {
        fail(new Error("Permission approval failed because the Jasmine page reloaded."));
      }
    };

    const onRenderProcessGone = () => {
      fail(new Error("Permission approval failed because the Jasmine renderer stopped."));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (sender.isDestroyed()) {
      onDestroyed();
      return;
    }

    pendingPermissions.set(id, {
      sender,
      resolve: finish,
      reject: fail
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    sender.once("destroyed", onDestroyed);
    sender.on("did-start-navigation", onNavigation);
    sender.once("render-process-gone", onRenderProcessGone);
    try {
      sender.send("permissionApproval:prompt", payload);
    } catch {
      fail(new Error("Permission approval failed because the Jasmine window closed."));
    }
  });
}

function assertSameSender(event: IpcMainInvokeEvent, expected: WebContents): void {
  if (event.sender.id !== expected.id) {
    throw new Error("Permission approval response came from a different Jasmine window.");
  }
}
