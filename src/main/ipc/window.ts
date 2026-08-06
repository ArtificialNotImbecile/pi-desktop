import { BrowserWindow, ipcMain } from "electron";
import { windowActionSchema } from "../../shared/schemas.js";

export function registerWindowIpc(): void {
  ipcMain.handle("window:state", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return { maximized: Boolean(win?.isMaximized()) };
  });

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

  function emitState(win: BrowserWindow) {
    win.webContents.send("window:state-changed", { maximized: win.isMaximized() });
  }
}
