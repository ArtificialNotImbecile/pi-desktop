import { defineConfig } from "@playwright/test";

// Targeted Playwright commands are easy to run directly while developing.
// Keep those runs off-screen by default too; the explicit headed npm script
// supplies an empty value, which intentionally opts out of this default.
if (process.env.JASMINE_E2E_OFFSCREEN === undefined) {
  process.env.JASMINE_E2E_OFFSCREEN = "1";
}

// Each test launches its own Electron instance against an isolated user data
// dir (single-instance lock is disabled under JASMINE_E2E_HARNESS), so tests
// are safe to run in parallel. Override with JASMINE_E2E_WORKERS=1 when
// debugging a single flaky test.
//
// macOS runs serially. Concurrent Electron launches there starve the heavier
// specs of their 45s budget: four workers failed ten specs on an 8-core Mac,
// including a shell that never became visible within 30s, and two still failed
// three. The same specs pass serially, at 5.3m against 3.9m for a two-worker
// run that has to be re-read for which failures were real. CI is unaffected
// either way, since it pins the count to 1.
const defaultWorkers = process.platform === "darwin" ? 1 : 4;
const workers = process.env.JASMINE_E2E_WORKERS
  ? Number(process.env.JASMINE_E2E_WORKERS)
  : defaultWorkers;

// The cold-start tests assert wall-clock startup budgets (first frame < 3.5s,
// settings-independent shell < 4s). They must not share the machine with a
// pack of parallel Electron launches, so they run alone after the main pass.
const startupTimingGrep = /Jasmine cold start/;

// Spotlight exercises a second BrowserWindow and shared window lifecycle.
// Keep it serial so parallel Electron launches cannot interfere with those
// visibility transitions. The default off-screen mode does not need OS focus.
const focusSensitiveGrep = /Spotlight quick launcher/;

// Four cases across three specs assert real desktop-session behavior -- window
// maximize/minimize, model-menu geometry, terminal resize/session, and Working
// notification behavior -- which a CI runner does not provide. They fail there on Linux and macOS alike, in
// partly different sets, while passing on a developer machine, so CI skips them
// via JASMINE_E2E_SKIP_DESKTOP_SESSION and a local run still covers them.
// Project-level grepInvert wins over the CLI flag, so the skip has to be woven
// in here rather than passed as --grep-invert.
const desktopSessionGrep = /@desktop-session/;
const skipDesktopSession = process.env.JASMINE_E2E_SKIP_DESKTOP_SESSION === "1";
const invert = (...patterns: RegExp[]) => skipDesktopSession ? [...patterns, desktopSessionGrep] : patterns;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../test-results/playwright",
  timeout: 45_000,
  expect: {
    timeout: 5_000
  },
  fullyParallel: true,
  workers,
  reporter: [["list"]],
  use: {
    actionTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "main",
      grepInvert: invert(startupTimingGrep, focusSensitiveGrep)
    },
    {
      name: "focus-sensitive",
      grep: focusSensitiveGrep,
      grepInvert: skipDesktopSession ? [desktopSessionGrep] : undefined,
      dependencies: ["main"],
      fullyParallel: false
    },
    {
      name: "startup-timing",
      grep: startupTimingGrep,
      grepInvert: skipDesktopSession ? [desktopSessionGrep] : undefined,
      dependencies: ["main", "focus-sensitive"],
      fullyParallel: false
    }
  ]
});
