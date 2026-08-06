import { app, ipcMain } from "electron";
import type { TerminalSession } from "../../shared/ipc.js";
import { terminalInputSchema, terminalResizeSchema, terminalStartSchema, terminalStopSchema } from "../../shared/schemas.js";
import type { TerminalProcess } from "../services/terminal.js";
import type { IpcContext } from "./context.js";

const sessions = new Map<string, TerminalProcess>();
let cleanupRegistered = false;

export function registerTerminalIpc(context: IpcContext): void {
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    app.on("before-quit", stopAllTerminalSessions);
  }

  ipcMain.handle("terminal:shell:resolve", async () => {
    const { resolveTerminalShell } = await import("../services/terminal.js");
    return resolveTerminalShell(context.getDatabase().getAppSettings().terminalShellPath);
  });

  ipcMain.handle("terminal:start", async (event, request: unknown): Promise<TerminalSession> => {
    const { resolveTerminalShell, startTerminalProcess } = await import("../services/terminal.js");
    const parsed = terminalStartSchema.parse(request);
    const shell = await resolveTerminalShell(context.getDatabase().getAppSettings().terminalShellPath);
    const cwd = parsed?.projectId === undefined
      ? parsed?.cwd
      : parsed.projectId === null
        ? context.getDatabase().getNeutralScratchCwd()
        : context.getDatabase().getProjectCwd(parsed.projectId);
    const terminal = startTerminalProcess({ shell, cwd, cols: parsed?.cols, rows: parsed?.rows });
    sessions.set(terminal.id, terminal);

    const send = (payload: { type: "data" | "exit" | "error"; data?: string; exitCode?: number | null }) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send("terminal:event", {
        sessionId: terminal.id,
        ...payload
      });
    };

    terminal.pty.onData((data) => send({ type: "data", data }));
    terminal.pty.onExit((event) => {
      send({ type: "exit", exitCode: event.exitCode });
      sessions.delete(terminal.id);
    });

    return {
      id: terminal.id,
      shell: terminal.shell,
      cwd: terminal.cwd,
      startedAt: terminal.startedAt
    };
  });

  ipcMain.handle("terminal:input", (_event, request: unknown): void => {
    const parsed = terminalInputSchema.parse(request);
    const terminal = sessions.get(parsed.sessionId);
    if (!terminal) throw new Error("Terminal session is not running.");
    terminal.pty.write(parsed.data);
  });

  ipcMain.handle("terminal:resize", (_event, request: unknown): void => {
    const parsed = terminalResizeSchema.parse(request);
    const terminal = sessions.get(parsed.sessionId);
    if (!terminal) return;
    terminal.pty.resize(parsed.cols, parsed.rows);
  });

  ipcMain.handle("terminal:stop", (_event, request: unknown): void => {
    const parsed = terminalStopSchema.parse(request);
    const terminal = sessions.get(parsed.sessionId);
    if (!terminal) return;
    terminal.pty.kill();
  });
}

function stopAllTerminalSessions(): void {
  for (const [sessionId, terminal] of sessions) {
    terminal.pty.kill();
    sessions.delete(sessionId);
  }
}
