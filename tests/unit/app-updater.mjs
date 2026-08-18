import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AppUpdateService,
  FakeAppUpdater,
  createInitialState,
  hasUpdateFeedConfig,
  isUpdaterUsable,
  safeUpdateError
} from "../../dist/main/main/services/appUpdater.js";

await testUnsupportedDevelopmentBuild();
testMissingUpdateFeedConfig();
await testManualUpdateLifecycle();
await testUpToDateAndRetryableError();
await testInactiveInstallationCheck();
await testManualInstallMode();
await testDownloadPageFailureIsVisible();
testUpdaterUsability();
testSecretRedaction();

console.log("app updater unit smoke passed");

async function testUnsupportedDevelopmentBuild() {
  const service = new AppUpdateService({
    updater: null,
    currentVersion: "1.2.3",
    broadcast() {}
  });
  assert.deepEqual(service.getState(), {
    phase: "unsupported",
    supported: false,
    installMode: "automatic",
    currentVersion: "1.2.3",
    availableVersion: null,
    progressPercent: null,
    bytesPerSecond: null,
    transferredBytes: null,
    totalBytes: null,
    lastCheckedAt: null,
    error: null
  });
  assert.equal((await service.checkForUpdates()).phase, "unsupported");
}

async function testManualUpdateLifecycle() {
  const updater = new FakeAppUpdater("available", "2.0.0");
  const states = [];
  let beforeInstallCalls = 0;
  const service = new AppUpdateService({
    updater,
    currentVersion: "1.2.3",
    broadcast(state) {
      states.push(state);
    },
    beforeInstall() {
      beforeInstallCalls += 1;
    }
  });

  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.deepEqual(await Promise.all([service.checkForUpdates(), service.checkForUpdates()]).then((items) => items.map((item) => item.phase)), ["available", "available"]);
  assert.equal(service.getState().availableVersion, "2.0.0");

  const downloaded = await service.downloadUpdate();
  assert.equal(downloaded.phase, "downloaded");
  assert.equal(downloaded.progressPercent, 100);
  assert.ok(states.some((state) => state.phase === "downloading" && state.progressPercent === 42));

  const installing = service.installUpdate();
  assert.equal(installing.phase, "installing");
  assert.equal(beforeInstallCalls, 1);
  assert.equal(updater.quitAndInstallCalls, 1);
}

async function testUpToDateAndRetryableError() {
  const current = new AppUpdateService({
    updater: new FakeAppUpdater("up-to-date"),
    currentVersion: "1.2.3",
    broadcast() {}
  });
  assert.equal((await current.checkForUpdates()).phase, "up-to-date");
  assert.ok(current.getState().lastCheckedAt);

  const failing = new AppUpdateService({
    updater: new FakeAppUpdater("error"),
    currentVersion: "1.2.3",
    broadcast() {}
  });
  const failed = await failing.checkForUpdates();
  assert.equal(failed.phase, "error");
  assert.match(failed.error || "", /Fake update check failed/);
  assert.equal((await failing.checkForUpdates()).phase, "error");
}

// An ad-hoc signed macOS build can see a new version but cannot install it, so
// About sends the user to the download page. Both in-place steps must refuse
// rather than leave a half-applied update behind.
async function testManualInstallMode() {
  const updater = new FakeAppUpdater("available", "2.0.0");
  const service = new AppUpdateService({
    updater,
    currentVersion: "1.2.3",
    installMode: "manual",
    broadcast() {}
  });

  assert.equal(service.getState().installMode, "manual");
  const checked = await service.checkForUpdates();
  assert.equal(checked.phase, "available");
  assert.equal(checked.availableVersion, "2.0.0");

  const downloaded = await service.downloadUpdate();
  assert.equal(downloaded.phase, "error");
  assert.match(downloaded.error || "", /cannot install updates itself/);
  assert.equal(service.installUpdate().phase, "error");
  assert.equal(updater.quitAndInstallCalls, 0);
}

// electron-updater resolves null rather than raising when the installation
// cannot update itself — a Linux build started outside its AppImage, say. The
// check must settle on a retryable error instead of hanging on "checking".
async function testInactiveInstallationCheck() {
  const service = new AppUpdateService({
    updater: {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
      on() {},
      async checkForUpdates() {
        return null;
      },
      async downloadUpdate() {
        return [];
      },
      quitAndInstall() {}
    },
    currentVersion: "1.2.3",
    broadcast() {}
  });
  const checked = await service.checkForUpdates();
  assert.equal(checked.phase, "error");
  assert.match(checked.error || "", /cannot install updates automatically/);
  assert.equal((await service.checkForUpdates()).phase, "error");
}

// A packaged `dir` build ships no app-update.yml, and letting it reach
// electron-updater surfaced a raw "ENOENT ... app-update.yml" on every macOS
// check. The missing file has to be read as "no feed" before the check runs, and
// the resulting state has to keep the manual download route open.
function testMissingUpdateFeedConfig() {
  const resourcesPath = mkdtempSync(path.join(tmpdir(), "jasmine-updater-"));
  assert.equal(hasUpdateFeedConfig(resourcesPath), false, "a dir build carries no feed");
  assert.equal(
    hasUpdateFeedConfig(resourcesPath, "http://127.0.0.1:8799/"),
    true,
    "an explicit feed override supplies a feed of its own"
  );

  writeFileSync(path.join(resourcesPath, "app-update.yml"), "provider: github\n");
  assert.equal(hasUpdateFeedConfig(resourcesPath), true, "an installer build carries a feed");

  const unconfigured = createInitialState("0.3.5", false, "manual");
  assert.equal(unconfigured.phase, "unsupported");
  assert.equal(unconfigured.supported, false);
  assert.equal(unconfigured.installMode, "manual", "the About page keys the download route off this");
}

// Only an AppImage build started outside its AppImage disowns itself. A deb
// install resolves to DebUpdater, which never implements the probe and must stay
// usable, and the Windows/macOS updaters do not implement it either -- so a
// missing probe can never be read as a refusal.
function testUpdaterUsability() {
  assert.equal(isUpdaterUsable(null), false);
  assert.equal(isUpdaterUsable(new FakeAppUpdater("available")), true, "an adapter without the probe stays usable");
  assert.equal(isUpdaterUsable({ isUpdaterActive: () => true }), true);
  assert.equal(isUpdaterUsable({ isUpdaterActive: () => false }), false, "only an explicit refusal disables updates");
}

// The download page is a manual-install build's only route forward, so a failed
// hand-off to the browser has to reach the user instead of vanishing.
async function testDownloadPageFailureIsVisible() {
  const service = new AppUpdateService({
    updater: new FakeAppUpdater("available", "2.0.0"),
    currentVersion: "1.2.3",
    installMode: "manual",
    broadcast() {}
  });
  const failed = service.reportDownloadPageFailure(
    new Error("no handler"),
    "https://example.test/releases/latest"
  );
  assert.equal(failed.phase, "error");
  assert.match(failed.error || "", /https:\/\/example\.test\/releases\/latest/);
  assert.match(failed.error || "", /no handler/);
}

function testSecretRedaction() {
  assert.equal(
    safeUpdateError(new Error("GET https://example.test/latest.yml?token=secret-value&channel=latest failed")),
    "GET https://example.test/latest.yml?token=[redacted]&channel=latest failed"
  );
  assert.equal(
    safeUpdateError("Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456 failed"),
    "Authorization: Bearer [redacted] failed"
  );
  assert.ok(safeUpdateError("x".repeat(800)).length <= 400);
}
