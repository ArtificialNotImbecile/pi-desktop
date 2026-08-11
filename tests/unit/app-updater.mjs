import assert from "node:assert/strict";
import {
  AppUpdateService,
  FakeAppUpdater,
  safeUpdateError
} from "../../dist/main/main/services/appUpdater.js";

await testUnsupportedDevelopmentBuild();
await testManualUpdateLifecycle();
await testUpToDateAndRetryableError();
await testInactiveInstallationCheck();
await testManualInstallMode();
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
