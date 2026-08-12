// App-level perf profiler: measures the user-reported lag surfaces —
// cold startup, mount-time IPC latencies, settings-open latency, and the
// synchronous executable-discovery / env-key resolution costs.
//
// Usage: node scripts/profile-app-perf.mjs   (requires a current `npm run build`)
// Launches WITHOUT JASMINE_E2E_*_CANDIDATES so real Windows discovery runs.

import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userDataDir = path.join(rootDir, ".tmp", "perf", `app-perf-${randomUUID()}`);

function launchEnv() {
  return {
    ...process.env,
    JASMINE_E2E_USER_DATA_DIR: userDataDir,
    JASMINE_E2E_HARNESS: "1",
    JASMINE_E2E_MOCK_AI: "1",
    DEEPSEEK_API_KEY: "perf-mock-key",
    KIMI_API_KEY: "perf-mock-key"
  };
}

function electronExecutable() {
  return path.join(rootDir, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
}

async function launch() {
  const startedAt = Date.now();
  const app = await electron.launch({
    executablePath: electronExecutable(),
    args: [".", "--disable-gpu"],
    cwd: rootDir,
    env: launchEnv()
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell", { timeout: 60_000 });
  return { app, page, shellMs: Date.now() - startedAt };
}

async function timeIpc(page, label, method, arg, samples = 3) {
  const timings = [];
  for (let i = 0; i < samples; i += 1) {
    const ms = await page.evaluate(async ({ method: name, arg: value }) => {
      const start = performance.now();
      await window.jasmine[name](value);
      return performance.now() - start;
    }, { method, arg });
    timings.push(Number(ms.toFixed(1)));
  }
  return { label, coldMs: timings[0], warmMs: timings.slice(1) };
}

async function main() {
  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });
  const results = {};

  // --- Standalone: PowerShell user-env lookup cost (resolveApiKey fallback path) ---
  if (process.platform === "win32") {
    const psStart = Date.now();
    try {
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('JASMINE_PERF_PROBE','User')"],
        { encoding: "utf8", windowsHide: true }
      );
    } catch { /* value does not matter */ }
    results.powershellEnvLookupMs = Date.now() - psStart;
  }

  // --- Pass 1: cold start on an empty profile ---
  let session = await launch();
  results.coldShellMsFreshProfile = session.shellMs;
  await session.app.close();

  // --- Pass 2: warm start (settings cache primed) + IPC latencies ---
  session = await launch();
  const { app, page } = session;
  results.warmShellMs = session.shellMs;

  const ipcProbes = [
    ["getAppSettings", "getAppSettings"],
    ["listThreads", "listThreads"],
    ["listProjects", "listProjects"],
    ["listProviders", "listProviders"],
    ["listSkills", "listSkills"],
    ["listPlugins", "listPlugins"],
    ["listPluginSkills", "listPluginSkills"],
    ["listPromptTemplates", "listPromptTemplates"],
    ["listMcpMarketplace", "listMcpMarketplace", undefined],
    ["listMcpServers", "listMcpServers"],
    ["getWebSearchSettings", "getWebSearchSettings"],
    ["getActivitySettings", "getActivitySettings"],
    ["execDiscovery(editor)", "listExecutableDiscovery", "editor"],
    ["execDiscovery(terminal)", "listExecutableDiscovery", "terminal"]
  ];
  results.ipc = [];
  for (const [label, method, arg] of ipcProbes) {
    results.ipc.push(await timeIpc(page, label, method, arg));
  }

  // --- Settings open latency (More menu -> Settings -> General interactive) ---
  const settingsStart = Date.now();
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForSelector(".settings-detail", { timeout: 30_000 });
  results.settingsPanelVisibleMs = Date.now() - settingsStart;
  // General section mounts executable discovery; wait until selects are populated.
  await page.waitForFunction(() => {
    const detail = document.querySelector(".settings-detail");
    return detail && detail.textContent && detail.textContent.length > 0;
  }, undefined, { timeout: 30_000 });
  results.settingsGeneralTextMs = Date.now() - settingsStart;

  await app.close();
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
