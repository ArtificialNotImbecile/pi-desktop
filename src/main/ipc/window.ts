import { BrowserWindow, ipcMain } from "electron";
import type { WindowState } from "../../shared/ipc.js";
import { windowActionSchema } from "../../shared/schemas.js";

function readState(win: BrowserWindow | null): WindowState {
  return {
    maximized: Boolean(win?.isMaximized()),
    fullScreen: Boolean(win?.isFullScreen())
  };
}

function emitState(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  win.webContents.send("window:state-changed", readState(win));
}

// Native chrome changes these without going through window:action — macOS
// traffic lights, title-bar double-click, OS shortcuts — and the renderer
// reserves title-bar inset space per state, so mirror the real events too.
export function attachWindowStateEvents(win: BrowserWindow): void {
  win.on("maximize", () => emitState(win));
  win.on("unmaximize", () => emitState(win));
  win.on("enter-full-screen", () => emitState(win));
  win.on("leave-full-screen", () => emitState(win));
}

export function registerWindowIpc(): void {
  ipcMain.handle("window:state", (event) => readState(BrowserWindow.fromWebContents(event.sender)));

  ipcMain.handle("window:action", (event, action: "minimize" | "maximize" | "close") => {
    action = windowActionSchema.parse(action);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === "minimize") win.minimize();
    if (action === "maximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
    if (action === "close") win.close();
    if (action !== "close") emitState(win);
  });
}
