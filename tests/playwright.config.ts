import { defineConfig } from "@playwright/test";

// Each test launches its own Electron instance against an isolated user data
// dir (single-instance lock is disabled under JASMINE_E2E_HARNESS), so tests
// are safe to run in parallel. Override with JASMINE_E2E_WORKERS=1 when
// debugging a single flaky test.
const workers = process.env.JASMINE_E2E_WORKERS
  ? Number(process.env.JASMINE_E2E_WORKERS)
  : 4;

// The cold-start tests assert wall-clock startup budgets (first frame < 3.5s,
// settings-independent shell < 4s). They must not share the machine with a
// pack of parallel Electron launches, so they run alone after the main pass.
const startupTimingGrep = /Jasmine cold start/;

// Spotlight exercises a second BrowserWindow and shared window lifecycle.
// Keep it serial so parallel Electron launches cannot interfere with those
// visibility transitions. The default off-screen mode does not need OS focus.
const focusSensitiveGrep = /Spotlight quick launcher/;

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
      grepInvert: [startupTimingGrep, focusSensitiveGrep]
    },
    {
      name: "focus-sensitive",
      grep: focusSensitiveGrep,
      dependencies: ["main"],
      fullyParallel: false
    },
    {
      name: "startup-timing",
      grep: startupTimingGrep,
      dependencies: ["main", "focus-sensitive"],
      fullyParallel: false
    }
  ]
});
