import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeImage, Notification, screen, Tray, type MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import { cp, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { DEFAULT_APPEARANCE } from "../shared/theme.js";
import type { AppLanguage, SpotlightExecuteRequest, WorkingNavigationTarget } from "../shared/ipc.js";
import type { JasmineDatabase } from "./db/database.js";
import { stopChromeBridge } from "./services/chromeBridge.js";
import { WorkingRegistry, type WorkingNotification } from "./services/workingRegistry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let database: JasmineDatabase | null = null;
let createDatabase: (() => JasmineDatabase) | null = null;
let workingRegistry: WorkingRegistry | null = null;
let ipcRegistered = false;
let mainWindow: BrowserWindow | null = null;
let spotlightWindow: BrowserWindow | null = null;
let spotlightShortcutRegistered = false;
let focusOnWindowCreate = false;
let tray: Tray | null = null;
let isQuitting = false;
let pendingSpotlightCommand: SpotlightExecuteRequest | null = null;
let pendingWorkingNavigation: WorkingNavigationTarget | null = null;
const harnessWorkingNotifications: Array<{ notification: WorkingNotification; click(): void }> = [];
const APP_USER_MODEL_ID = "works.earendil.jasmine";
const SPOTLIGHT_SHORTCUT = "Alt+Space";
const SPOTLIGHT_WIDTH = 680;
const SPOTLIGHT_HEIGHT = 460;
const isE2eHarness = process.env.JASMINE_E2E_HARNESS === "1";
// Off-screen harness mode: windows are fully transparent, skip the taskbar,
// and start parked at the bottom-right desktop corner so a local e2e run does
// not pop windows over the developer's session. Playwright drives the page
// over CDP, which needs neither OS visibility nor focus. Not gated on
// JASMINE_E2E_HARNESS because cold-start specs launch without the harness flag.
const isE2eOffscreen = process.env.JASMINE_E2E_OFFSCREEN === "1";

// Keep a 1px overlap with the desktop: fully detached positions (e.g. -32000)
// make Windows report minimized-style frame insets, which shifts content
// bounds and window.innerWidth away from what a visible run would measure.
function offscreenWindowPosition(): { x: number; y: number } {
  const displays = screen.getAllDisplays();
  const maxX = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const maxY = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
  return { x: maxX - 1, y: maxY - 1 };
}

if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let legacyUserData: string | null = null;
if (process.env.JASMINE_E2E_USER_DATA_DIR) {
  app.disableHardwareAcceleration();
  app.setPath("userData", process.env.JASMINE_E2E_USER_DATA_DIR);
} else {
  legacyUserData = app.getPath("userData");
  app.setPath("userData", path.join(os.homedir(), ".jasmine"));
}

const useSingleInstanceLock = process.env.JASMINE_E2E_HARNESS !== "1";
const singleInstanceLock = useSingleInstanceLock ? app.requestSingleInstanceLock() : true;
if (!singleInstanceLock) {
  app.quit();
} else if (useSingleInstanceLock) {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

function createWindow() {
  if (!singleInstanceLock) return null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }
  const appIcon = loadAppIcon();
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 840,
    minHeight: 600,
    title: "Jasmine — The desktop app for Pi",
    titleBarStyle: "hidden",
    resizable: true,
    movable: true,
    maximizable: true,
    minimizable: true,
    icon: appIcon,
    show: false,
    backgroundColor: DEFAULT_APPEARANCE.surface,
    // Fully transparent and out of the taskbar: even when a test maximizes or
    // repositions the window onto a display, nothing shows on the desktop.
    // CDP-driven input and screenshots work on the renderer surface and are
    // unaffected by OS-level window opacity.
    ...(isE2eOffscreen
      ? { ...offscreenWindowPosition(), opacity: 0, skipTaskbar: true, focusable: false }
      : {}),
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // Off-screen windows count as occluded; keep timers and rAF at full
      // speed so streaming and animation behavior matches a visible run.
      ...(isE2eOffscreen ? { backgroundThrottling: false } : {})
    }
  });
  mainWindow = win;
  win.on("close", (event) => {
    if (isQuitting || !tray) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  if (!appIcon.isEmpty()) win.setIcon(appIcon);
  return win;
}

if (singleInstanceLock) {
  app.whenReady().then(async () => {
    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) void startApplication();
      else showMainWindow();
    });
    await startApplication();
  }).catch((error) => {
    console.error("Failed to start Jasmine:", error);
    app.quit();
  });
}

app.on("window-all-closed", () => {
  // The app stays resident in the system tray; only an explicit tray "Exit"
  // (or another before-quit path) shuts it down. Without a tray we fall back
  // to the platform default so the process can never get stuck headless.
  if (!tray && process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  void stopChromeBridge().catch((error) => {
    console.warn("Failed to clean up Chrome bridge:", error);
  });
  globalShortcut.unregisterAll();
  spotlightShortcutRegistered = false;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

function getDatabase(): JasmineDatabase {
  if (!createDatabase) throw new Error("Jasmine is still starting.");
  database ??= createDatabase();
  return database;
}

function getWorkingRegistry(): WorkingRegistry {
  workingRegistry ??= new WorkingRegistry(getDatabase(), {
    broadcast(snapshot) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("working:changed", snapshot);
    },
    isBackground() {
      return !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized() || !mainWindow.isFocused();
    },
    showNotification(notification, onClick) {
      if (isE2eHarness) {
        harnessWorkingNotifications.push({ notification, click: onClick });
        return true;
      }
      if (!Notification.isSupported()) return false;
      const toast = new Notification({ title: notification.title, body: notification.body });
      toast.once("click", onClick);
      toast.show();
      return true;
    },
    route: routeWorkingNavigation
  });
  return workingRegistry;
}

function consumePendingWorkingNavigation(): WorkingNavigationTarget | null {
  const target = pendingWorkingNavigation;
  pendingWorkingNavigation = null;
  return target;
}

async function startApplication(): Promise<void> {
  const win = createWindow();
  if (!win) return;

  await showStartupScreen(win);

  try {
    if (ipcRegistered) {
      await loadApplication(win);
      return;
    }
    if (legacyUserData) {
      await migrateLegacyUserData(legacyUserData, app.getPath("userData"));
    }
    await delayForStartupRegression();

    const [{ JasmineDatabase }, { registerIpc }, { registerSpotlightIpc }] = await Promise.all([
      import("./db/database.js"),
      import("./ipc/index.js"),
      import("./ipc/spotlight.js")
    ]);
    createDatabase = () => new JasmineDatabase();
    registerIpc({ getDatabase, getWorkingRegistry, consumePendingWorkingNavigation });
    getWorkingRegistry().initialize();
    registerSpotlightIpc(
      { getDatabase },
      {
        hideSpotlight,
        routeCommand: routeSpotlightCommand,
        consumePendingCommand: () => {
          const command = pendingSpotlightCommand;
          pendingSpotlightCommand = null;
          return command;
        }
      }
    );
    setupApplicationMenu();
    createTray();
    registerSpotlightShortcut();
    if (isE2eHarness) {
      (globalThis as { __jasmineSpotlight?: unknown }).__jasmineSpotlight = {
        show: showSpotlight,
        hide: hideSpotlight,
        toggle: toggleSpotlight
      };
      (globalThis as { __jasmineTray?: unknown }).__jasmineTray = {
        openMain: () => showMainWindow(),
        quit: () => quitApplication(),
        isMainVisible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
        isMainAlive: () => Boolean(mainWindow && !mainWindow.isDestroyed()),
        hasTray: () => Boolean(tray)
      };
      (globalThis as { __jasmineWorkingNotifications?: unknown }).__jasmineWorkingNotifications = {
        list: () => harnessWorkingNotifications.map((item) => item.notification),
        clear: () => { harnessWorkingNotifications.splice(0); },
        click: (index: number) => harnessWorkingNotifications[index]?.click()
      };
    }
    ipcRegistered = true;

    await loadApplication(win);
    setTimeout(() => {
      void warmDatabase();
    }, 1000);
  } catch (error) {
    console.error("Failed to initialize Jasmine:", error);
    await showStartupError(win, error);
  }
}

async function warmDatabase(): Promise<void> {
  try {
    getDatabase();
  } catch (error) {
    console.error("Failed to initialize Jasmine database:", error);
  }
}

function setupApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder...",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            void openProjectFolderFromMenu();
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openProjectFolderFromMenu(): Promise<void> {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();
  const pickedPath = process.env.JASMINE_E2E_PICK_PROJECT_FOLDER
    ? process.env.JASMINE_E2E_PICK_PROJECT_FOLDER
    : await pickProjectFolderFromMenu(win);
  if (!pickedPath) return;
  try {
    const project = getDatabase().createProjectFromPath(pickedPath);
    const target = win && !win.isDestroyed() ? win : mainWindow;
    target?.webContents.send("projects:opened", project);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not open folder.";
    if (win && !win.isDestroyed()) {
      await dialog.showMessageBox(win, {
        type: "error",
        title: "Open Folder",
        message
      });
    }
  }
}

async function pickProjectFolderFromMenu(owner?: BrowserWindow | null): Promise<string | null> {
  const options = {
    title: "Open folder",
    properties: ["openDirectory" as const]
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
}

function focusMainWindow(): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win) {
    focusOnWindowCreate = true;
    return;
  }
  if (win.isMinimized()) win.restore();
  if (isE2eOffscreen) {
    win.showInactive();
  } else {
    win.show();
    win.focus();
  }
  focusOnWindowCreate = false;
}

// Brings the main window back to the foreground, rebuilding and reloading it
// when it was hidden to the tray or destroyed. This is the single entry point
// used by the tray, the global shortcut router, and second-instance launches.
function showMainWindow(): BrowserWindow | null {
  hideSpotlight();
  refreshTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (isE2eOffscreen) {
      mainWindow.showInactive();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    focusOnWindowCreate = false;
    return mainWindow;
  }
  focusOnWindowCreate = true;
  void startApplication();
  return mainWindow;
}

function quitApplication(): void {
  isQuitting = true;
  app.quit();
}

function createTray(): void {
  if (tray) return;
  const icon = loadAppIcon();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Jasmine");
  refreshTrayMenu();
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const labels = trayLabels(resolveTrayLanguage());
  const menu = Menu.buildFromTemplate([
    { label: labels.open, click: () => showMainWindow() },
    { type: "separator" },
    { label: labels.quit, click: () => quitApplication() }
  ]);
  tray.setContextMenu(menu);
}

function resolveTrayLanguage(): AppLanguage {
  try {
    return getDatabase().getAppSettings().language;
  } catch {
    return "en";
  }
}

function trayLabels(language: AppLanguage): { open: string; quit: string } {
  if (language === "zh") {
    return { open: "\u6253\u5f00 Jasmine", quit: "\u9000\u51fa" };
  }
  return { open: "Open Jasmine", quit: "Quit Jasmine" };
}

// Routes a Spotlight command to the main window. In the common case the window
// is alive (possibly hidden in the tray), so the command is delivered directly
// to the already-mounted renderer bridge. When the window must be rebuilt, the
// command is queued and the renderer pulls it via spotlight:consumePending once
// the bridge mounts, which avoids losing commands to a load/listener race.
function routeSpotlightCommand(payload: SpotlightExecuteRequest): void {
  hideSpotlight();
  const existing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (existing) {
    if (shouldQueueSpotlightCommand(existing)) {
      pendingSpotlightCommand = payload;
      showMainWindow();
      return;
    }
    showMainWindow();
    existing.webContents.send("spotlight:command", payload);
    return;
  }
  pendingSpotlightCommand = payload;
  showMainWindow();
}

function routeWorkingNavigation(target: WorkingNavigationTarget): void {
  const existing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (existing) {
    if (shouldQueueSpotlightCommand(existing)) {
      pendingWorkingNavigation = target;
      showMainWindow();
      return;
    }
    showMainWindow();
    existing.webContents.send("working:navigate", target);
    return;
  }
  pendingWorkingNavigation = target;
  showMainWindow();
}

function shouldQueueSpotlightCommand(win: BrowserWindow): boolean {
  const url = win.webContents.getURL();
  return !url || url.startsWith("data:") || win.webContents.isLoadingMainFrame();
}

function createSpotlightWindow(): BrowserWindow {
  if (spotlightWindow && !spotlightWindow.isDestroyed()) return spotlightWindow;
  const win = new BrowserWindow({
    width: SPOTLIGHT_WIDTH,
    height: SPOTLIGHT_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    ...(isE2eOffscreen
      ? { ...offscreenWindowPosition(), opacity: 0, focusable: false, alwaysOnTop: false }
      : { alwaysOnTop: true }),
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      ...(isE2eOffscreen ? { backgroundThrottling: false } : {})
    }
  });
  if (!isE2eOffscreen) win.setAlwaysOnTop(true, "floating");
  if (!isE2eHarness) {
    win.on("blur", () => hideSpotlight());
  }
  win.on("closed", () => {
    if (spotlightWindow === win) spotlightWindow = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(`${devUrl.replace(/\/$/, "")}/spotlight.html`);
  } else {
    void win.loadFile(path.join(__dirname, "../../renderer/spotlight.html"));
  }

  spotlightWindow = win;
  return win;
}

function showSpotlight(): void {
  const win = createSpotlightWindow();
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  const winX = Math.round(x + (width - SPOTLIGHT_WIDTH) / 2);
  const winY = Math.round(y + height * 0.22);
  win.setBounds({ x: winX, y: winY, width: SPOTLIGHT_WIDTH, height: SPOTLIGHT_HEIGHT });
  if (isE2eOffscreen) win.showInactive();
  else win.show();
  focusSpotlightWindow(win);
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once("did-finish-load", () => {
      focusSpotlightWindow(win);
      setTimeout(() => focusSpotlightWindow(win), 50);
    });
  } else {
    setTimeout(() => focusSpotlightWindow(win), 50);
  }
}

function focusSpotlightWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || !win.isVisible()) return;
  if (!isE2eOffscreen) {
    win.focus();
    win.webContents.focus();
  }
  win.webContents.send("spotlight:reset");
}

function hideSpotlight(): void {
  if (spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible()) {
    spotlightWindow.hide();
  }
}

function toggleSpotlight(): void {
  if (spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible()) {
    hideSpotlight();
  } else {
    showSpotlight();
  }
}

function registerSpotlightShortcut(): void {
  if (spotlightShortcutRegistered) return;
  try {
    const ok = globalShortcut.register(SPOTLIGHT_SHORTCUT, () => toggleSpotlight());
    if (!ok) {
      console.warn(`Spotlight shortcut ${SPOTLIGHT_SHORTCUT} could not be registered (likely in use).`);
      return;
    }
    spotlightShortcutRegistered = true;
  } catch (error) {
    console.warn(`Spotlight shortcut ${SPOTLIGHT_SHORTCUT} registration failed:`, error);
  }
}

function resolvePreloadPath(): string {
  const candidates = [
    path.join(process.cwd(), "src/main/preload.cjs"),
    path.join(__dirname, "../../../src/main/preload.cjs"),
    path.join(__dirname, "preload.js")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function loadAppIcon() {
  for (const candidate of getAppIconCandidates()) {
    if (!existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createEmpty();
}

function getAppIconCandidates() {
  const packagedResourcesRoot = typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  return [
    packagedResourcesRoot ? path.join(packagedResourcesRoot, "jasmine-resources", "jasmine-logo.ico") : "",
    packagedResourcesRoot ? path.join(packagedResourcesRoot, "jasmine-resources", "jasmine-logo.png") : "",
    path.join(process.cwd(), "resources", "jasmine-logo.ico"),
    path.join(process.cwd(), "resources", "jasmine-logo.png"),
    path.join(__dirname, "../../../resources/jasmine-logo.ico"),
    path.join(__dirname, "../../../resources/jasmine-logo.png")
  ];
}

async function showStartupScreen(win: BrowserWindow): Promise<void> {
  await win.loadURL(startupPageUrl("loading"));
  if (win.isDestroyed()) return;
  if (isE2eOffscreen) win.showInactive();
  else win.show();
  if (focusOnWindowCreate) focusMainWindow();
}

async function loadApplication(win: BrowserWindow): Promise<void> {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

async function showStartupError(win: BrowserWindow, error: unknown): Promise<void> {
  if (win.isDestroyed()) return;
  const message = error instanceof Error ? error.message : "Unknown startup error.";
  await win.loadURL(startupPageUrl("error", message)).catch(() => undefined);
  if (win.isDestroyed()) return;
  if (isE2eOffscreen) win.showInactive();
  else win.show();
}

function startupPageUrl(state: "loading" | "error", detail = ""): string {
  const isError = state === "error";
  const copyMarkup = isError
    ? '<h1>Jasmine could not start</h1><p>Close Jasmine and try again. Startup details are shown below.</p>'
    : "";
  const detailMarkup = isError ? `<pre>${escapeHtml(detail)}</pre>` : '<div class="spinner" aria-hidden="true"></div>';
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Jasmine</title>
    <style>
      :root { color-scheme: light; font-family: Inter, "Segoe UI", sans-serif; background: ${DEFAULT_APPEARANCE.surface}; color: ${DEFAULT_APPEARANCE.ink}; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: ${DEFAULT_APPEARANCE.surface}; }
      main { width: min(420px, calc(100vw - 48px)); text-align: center; }
      .mark { width: 42px; height: 42px; margin: 0 auto 18px; border: 1px solid color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 13%, ${DEFAULT_APPEARANCE.surface}); border-radius: 12px; display: grid; place-items: center; background: ${DEFAULT_APPEARANCE.surface}; box-shadow: 0 6px 18px color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 6%, transparent); }
      .flower { width: 18px; height: 18px; border-radius: 50%; background: ${DEFAULT_APPEARANCE.accent}; box-shadow: 0 -7px 0 -3px color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 52%, ${DEFAULT_APPEARANCE.surface}), 0 7px 0 -3px color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 52%, ${DEFAULT_APPEARANCE.surface}), 7px 0 0 -3px color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 52%, ${DEFAULT_APPEARANCE.surface}), -7px 0 0 -3px color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 52%, ${DEFAULT_APPEARANCE.surface}); }
      h1 { margin: 0; font-size: 18px; font-weight: 600; }
      p { margin: 8px 0 0; color: color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 58%, ${DEFAULT_APPEARANCE.surface}); font-size: 13px; }
      .spinner { width: 18px; height: 18px; margin: 22px auto 0; border: 2px solid color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 13%, ${DEFAULT_APPEARANCE.surface}); border-top-color: ${DEFAULT_APPEARANCE.accent}; border-radius: 50%; animation: spin .8s linear infinite; }
      pre { margin: 18px 0 0; padding: 12px; max-height: 180px; overflow: auto; border: 1px solid color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 12%, ${DEFAULT_APPEARANCE.surface}); border-radius: 8px; background: color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 4%, ${DEFAULT_APPEARANCE.surface}); color: ${DEFAULT_APPEARANCE.danger}; text-align: left; white-space: pre-wrap; font: 12px/1.5 "JetBrains Mono", Consolas, monospace; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-color: color-mix(in srgb, ${DEFAULT_APPEARANCE.ink} 13%, ${DEFAULT_APPEARANCE.surface}); border-top-color: ${DEFAULT_APPEARANCE.accent}; } }
    </style>
  </head>
  <body>
    <main data-jasmine-startup="${state}" role="${isError ? "alert" : "status"}">
      <div class="mark" aria-hidden="true"><div class="flower"></div></div>
      ${copyMarkup}
      ${detailMarkup}
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}

async function delayForStartupRegression(): Promise<void> {
  const delayMs = Number.parseInt(process.env.JASMINE_STARTUP_DELAY_MS ?? "", 10);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 15_000)));
}

async function migrateLegacyUserData(legacyUserData: string, jasmineUserData: string): Promise<void> {
  if (path.resolve(legacyUserData) === path.resolve(jasmineUserData)) return;
  const legacyDataDir = path.join(legacyUserData, "data");
  const nextDataDir = path.join(jasmineUserData, "data");
  const legacyDb = path.join(legacyDataDir, "jasmine.sqlite");
  const nextDb = path.join(nextDataDir, "jasmine.sqlite");
  if (!(await pathExists(legacyDb)) || await pathExists(nextDb)) return;
  await mkdir(jasmineUserData, { recursive: true });
  await cp(legacyDataDir, nextDataDir, { recursive: true, force: false, errorOnExist: true });
}

async function pathExists(candidate: string): Promise<boolean> {
  return stat(candidate).then(() => true, () => false);
}
