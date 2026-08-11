import { EventEmitter } from "node:events";
import type { AppUpdateInstallMode, AppUpdateState } from "../../shared/ipc.js";

type UpdateInfo = {
  version: string;
};

type DownloadProgress = {
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
};

type UpdateCheckResult = {
  isUpdateAvailable: boolean;
  updateInfo: UpdateInfo;
} | null;

export interface AppUpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(event: "update-available" | "update-not-available", listener: (info: UpdateInfo) => void): unknown;
  on(event: "download-progress", listener: (progress: DownloadProgress) => void): unknown;
  on(event: "update-downloaded", listener: (info: UpdateInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<UpdateCheckResult>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  // Present on electron-updater's per-platform updaters. It reports whether the
  // running installation can install updates at all — a Linux build started
  // outside its AppImage answers false and silently resolves checks to null.
  isUpdaterActive?(): boolean;
  setFeedURL?(options: unknown): void;
}

export type AppUpdateServiceOptions = {
  updater: AppUpdaterAdapter | null;
  currentVersion: string;
  installMode?: AppUpdateInstallMode;
  broadcast(state: AppUpdateState): void;
  beforeInstall?(): void;
};

export class AppUpdateService {
  private state: AppUpdateState;
  private checkPromise: Promise<AppUpdateState> | null = null;
  private downloadPromise: Promise<AppUpdateState> | null = null;

  constructor(private readonly options: AppUpdateServiceOptions) {
    this.state = createInitialState(
      options.currentVersion,
      Boolean(options.updater),
      options.installMode ?? "automatic"
    );
    if (!options.updater) return;

    options.updater.autoDownload = false;
    options.updater.autoInstallOnAppQuit = false;
    options.updater.allowPrerelease = false;
    options.updater.on("checking-for-update", () => {
      this.updateState({ phase: "checking", error: null });
    });
    options.updater.on("update-available", (info) => {
      this.updateState({
        phase: "available",
        availableVersion: info.version,
        lastCheckedAt: new Date().toISOString(),
        error: null
      });
    });
    options.updater.on("update-not-available", () => {
      this.updateState({
        phase: "up-to-date",
        availableVersion: null,
        lastCheckedAt: new Date().toISOString(),
        error: null
      });
    });
    options.updater.on("download-progress", (progress) => {
      this.updateState({
        phase: "downloading",
        progressPercent: finiteNumber(progress.percent),
        bytesPerSecond: finiteNumber(progress.bytesPerSecond),
        transferredBytes: finiteNumber(progress.transferred),
        totalBytes: finiteNumber(progress.total),
        error: null
      });
    });
    options.updater.on("update-downloaded", (info) => {
      this.updateState({
        phase: "downloaded",
        availableVersion: info.version || this.state.availableVersion,
        progressPercent: 100,
        error: null
      });
    });
    options.updater.on("error", (error) => {
      this.setError(error);
    });
  }

  getState(): AppUpdateState {
    return { ...this.state };
  }

  async checkForUpdates(): Promise<AppUpdateState> {
    if (!this.options.updater) return this.getState();
    if (this.checkPromise) return this.checkPromise;
    if (this.state.phase === "downloading" || this.state.phase === "installing") return this.getState();

    this.updateState({
      phase: "checking",
      progressPercent: null,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      error: null
    });
    this.checkPromise = this.options.updater.checkForUpdates()
      .then((result) => {
        // The real updater emits the availability event before this promise
        // resolves. This fallback keeps deterministic adapters equally useful.
        if (this.state.phase !== "checking") return this.getState();
        if (!result) {
          // electron-updater resolves null instead of raising when the running
          // installation cannot update itself; without this the UI would hang
          // on "checking" forever.
          this.setError(new Error("This installation cannot install updates automatically."));
          return this.getState();
        }
        this.updateState(result.isUpdateAvailable
          ? {
              phase: "available",
              availableVersion: result.updateInfo.version,
              lastCheckedAt: new Date().toISOString(),
              error: null
            }
          : {
              phase: "up-to-date",
              availableVersion: null,
              lastCheckedAt: new Date().toISOString(),
              error: null
            });
        return this.getState();
      })
      .catch((error: unknown) => {
        this.setError(error);
        return this.getState();
      })
      .finally(() => {
        this.checkPromise = null;
      });
    return this.checkPromise;
  }

  async downloadUpdate(): Promise<AppUpdateState> {
    if (!this.options.updater) return this.getState();
    if (this.downloadPromise) return this.downloadPromise;
    if (this.state.installMode === "manual") {
      this.setError(new Error("This build cannot install updates itself; download the new version instead."));
      return this.getState();
    }
    if (this.state.phase !== "available") {
      this.setError(new Error("Check for an available update before downloading."));
      return this.getState();
    }

    this.updateState({
      phase: "downloading",
      progressPercent: 0,
      bytesPerSecond: null,
      transferredBytes: 0,
      totalBytes: null,
      error: null
    });
    this.downloadPromise = this.options.updater.downloadUpdate()
      .then(() => {
        if (this.state.phase === "downloading") {
          this.updateState({ phase: "downloaded", progressPercent: 100, error: null });
        }
        return this.getState();
      })
      .catch((error: unknown) => {
        this.setError(error);
        return this.getState();
      })
      .finally(() => {
        this.downloadPromise = null;
      });
    return this.downloadPromise;
  }

  installUpdate(): AppUpdateState {
    if (!this.options.updater) return this.getState();
    if (this.state.installMode === "manual") {
      this.setError(new Error("This build cannot install updates itself; download the new version instead."));
      return this.getState();
    }
    if (this.state.phase !== "downloaded") {
      this.setError(new Error("Download the update before installing it."));
      return this.getState();
    }
    this.updateState({ phase: "installing", error: null });
    try {
      // electron-updater closes windows before Electron's normal before-quit
      // event, so the app must bypass its close-to-tray handler first.
      this.options.beforeInstall?.();
      this.options.updater.quitAndInstall(false, true);
    } catch (error) {
      this.setError(error);
    }
    return this.getState();
  }

  // The download page is the only route a manual-install build has, so a failed
  // hand-off to the browser has to surface rather than vanish into a dropped
  // promise. The destination rides along so it can still be copied by hand.
  reportDownloadPageFailure(error: unknown, url: string): AppUpdateState {
    this.setError(new Error(`Could not open the download page. Visit ${url} — ${safeUpdateError(error)}`));
    return this.getState();
  }

  private setError(error: unknown): void {
    this.updateState({ phase: "error", error: safeUpdateError(error) });
  }

  private updateState(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.options.broadcast(this.getState());
  }
}

// Only electron-updater's AppImageUpdater reports itself inactive, and only
// when the build was started outside its AppImage. A deb install resolves to
// DebUpdater, which inherits the base "packaged is enough" answer, so it stays
// usable; Windows and macOS updaters do not implement the probe at all. Absent
// means usable — never treat a missing probe as a refusal.
export function isUpdaterUsable(updater: AppUpdaterAdapter | null): boolean {
  if (!updater) return false;
  return updater.isUpdaterActive?.() !== false;
}

export function createInitialState(
  currentVersion: string,
  supported: boolean,
  installMode: AppUpdateInstallMode = "automatic"
): AppUpdateState {
  return {
    phase: supported ? "idle" : "unsupported",
    supported,
    installMode,
    currentVersion,
    availableVersion: null,
    progressPercent: null,
    bytesPerSecond: null,
    transferredBytes: null,
    totalBytes: null,
    lastCheckedAt: null,
    error: null
  };
}

export function safeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "Update failed.");
  return raw
    .replace(/([?&](?:token|access_token|auth|authorization)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400) || "Update failed.";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type FakeUpdaterScenario = "available" | "up-to-date" | "error";

export class FakeAppUpdater extends EventEmitter implements AppUpdaterAdapter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  quitAndInstallCalls = 0;

  constructor(
    private readonly scenario: FakeUpdaterScenario = "available",
    private readonly availableVersion = "9.9.9"
  ) {
    super();
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    this.emit("checking-for-update");
    await Promise.resolve();
    if (this.scenario === "error") {
      const error = new Error("Fake update check failed.");
      this.emit("error", error);
      throw error;
    }
    const info = { version: this.scenario === "available" ? this.availableVersion : "0.0.0" };
    this.emit(this.scenario === "available" ? "update-available" : "update-not-available", info);
    return { isUpdateAvailable: this.scenario === "available", updateInfo: info };
  }

  async downloadUpdate(): Promise<string[]> {
    this.emit("download-progress", {
      percent: 42,
      bytesPerSecond: 1_048_576,
      transferred: 4_200_000,
      total: 10_000_000
    });
    await Promise.resolve();
    this.emit("update-downloaded", { version: this.availableVersion });
    return ["fake-update.exe"];
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls += 1;
  }
}
