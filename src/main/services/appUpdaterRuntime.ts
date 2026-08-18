import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow } from "electron";
import type { AppUpdateInstallMode, AppUpdateState } from "../../shared/ipc.js";
import {
  AppUpdateService,
  FakeAppUpdater,
  hasUpdateFeedConfig,
  isUpdaterUsable,
  type AppUpdaterAdapter
} from "./appUpdater.js";

const execFileAsync = promisify(execFile);

export const RELEASES_PAGE_URL = "https://github.com/ArtificialNotImbecile/pi-desktop/releases/latest";

let service = new AppUpdateService({
  updater: null,
  currentVersion: app.getVersion(),
  broadcast: () => undefined
});

export async function initializeAppUpdater(beforeInstall: () => void): Promise<AppUpdateService> {
  const { updater, installMode } = await resolveUpdater();
  service = new AppUpdateService({
    updater,
    currentVersion: app.getVersion(),
    installMode,
    beforeInstall,
    broadcast: broadcastUpdateState
  });
  return service;
}

export function getAppUpdater(): AppUpdateService {
  return service;
}

// electron-updater ships an installer-aware updater for each of these: NSIS on
// Windows, Squirrel.Mac on macOS, and AppImage/deb/rpm/pacman on Linux.
const UPDATABLE_PLATFORMS = new Set<NodeJS.Platform>(["win32", "darwin", "linux"]);

type ResolvedUpdater = {
  updater: AppUpdaterAdapter | null;
  installMode: AppUpdateInstallMode;
};

async function resolveUpdater(): Promise<ResolvedUpdater> {
  const forcedInstallMode = readForcedInstallMode();
  const fakeScenario = process.env.JASMINE_E2E_FAKE_UPDATER;
  if (fakeScenario) {
    const scenario = fakeScenario === "error" || fakeScenario === "up-to-date" ? fakeScenario : "available";
    return {
      updater: new FakeAppUpdater(scenario, process.env.JASMINE_E2E_FAKE_UPDATE_VERSION || "9.9.9"),
      installMode: forcedInstallMode ?? "automatic"
    };
  }
  if (!app.isPackaged || !UPDATABLE_PLATFORMS.has(process.platform)) {
    return { updater: null, installMode: "automatic" };
  }
  // Nothing downstream can recover from a missing feed, so decide it before the
  // electron-updater import and send those builds to the download page.
  if (!hasUpdateFeedConfig(process.resourcesPath, process.env.JASMINE_E2E_UPDATE_FEED_URL)) {
    return { updater: null, installMode: "manual" };
  }

  // Started before the import so the codesign probe overlaps it rather than
  // adding its own step to cold start.
  const installModePromise = forcedInstallMode ? Promise.resolve(forcedInstallMode) : resolveInstallMode();
  try {
    const updaterModule = await import("electron-updater");
    const defaultExport = updaterModule.default as { autoUpdater?: AppUpdaterAdapter } | undefined;
    const updater = (updaterModule.autoUpdater as AppUpdaterAdapter | undefined) ?? defaultExport?.autoUpdater ?? null;
    if (!updater) return { updater: null, installMode: "automatic" };
    applyFeedOverride(updater);
    // A Linux build launched outside its AppImage is the one installation the
    // platform updaters disown. Treat it as unsupported so About offers no dead
    // "Check for updates" button. deb/rpm installs stay usable.
    if (!isUpdaterUsable(updater)) return { updater: null, installMode: "automatic" };
    return { updater, installMode: await installModePromise };
  } catch (error) {
    console.warn("Failed to initialize Jasmine auto-update support:", error);
    return { updater: null, installMode: "automatic" };
  }
}

function readForcedInstallMode(): AppUpdateInstallMode | null {
  const forced = process.env.JASMINE_E2E_UPDATE_INSTALL_MODE;
  return forced === "manual" || forced === "automatic" ? forced : null;
}

// Squirrel.Mac validates a downloaded bundle against the designated requirement
// of the running app. An ad-hoc signature pins that requirement to this exact
// build's cdhash, so no later version can ever satisfy it and the install is
// rejected outright. Such builds may still check for updates; they just send the
// user to the download page rather than replacing themselves.
async function resolveInstallMode(): Promise<AppUpdateInstallMode> {
  if (process.platform !== "darwin") return "automatic";

  const bundlePath = path.resolve(app.getPath("exe"), "..", "..", "..");
  try {
    // codesign reports the signature on stderr.
    const { stderr } = await execFileAsync("codesign", ["--display", "--verbose=2", bundlePath]);
    const isAdHoc = /\bflags=[^\n]*\badhoc\b/.test(stderr);
    const hasTeam = /^TeamIdentifier=(?!not set)\S+/m.test(stderr);
    return !isAdHoc && hasTeam ? "automatic" : "manual";
  } catch (error) {
    // Unsigned bundles fail the same validation, and so does a missing codesign.
    console.warn("Falling back to manual Jasmine updates; the code signature could not be read:", error);
    return "manual";
  }
}

// Points a packaged build at a local update feed so the full check → download →
// install cycle can be rehearsed without publishing a GitHub release.
function applyFeedOverride(updater: AppUpdaterAdapter): void {
  const url = process.env.JASMINE_E2E_UPDATE_FEED_URL;
  if (!url || !updater.setFeedURL) return;
  try {
    updater.setFeedURL({ provider: "generic", url });
  } catch (error) {
    console.warn("Failed to apply the Jasmine update feed override:", error);
  }
}

function broadcastUpdateState(state: AppUpdateState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("updater:changed", state);
  }
}
