import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  baseLaunchEnv,
  quitElectron,
  resolveElectronExecutable,
  rootDir,
  waitForAppShellPage,
  waitForChildExit
} from "./helpers";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (filename: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

test.describe("Jasmine cold start", () => {
  test("shows startup feedback before initialization and coalesces repeated launches", async () => {
    const userDataDir = path.join(rootDir, ".tmp", "e2e", `cold-start-${randomUUID()}`);
    await rm(userDataDir, { recursive: true, force: true });
    await mkdir(userDataDir, { recursive: true });
    const executablePath = resolveElectronExecutable();
    const launchEnv = baseLaunchEnv(userDataDir, { JASMINE_STARTUP_DELAY_MS: "5000" });
    const startedAt = Date.now();
    const app = await electron.launch({
      executablePath,
      args: [".", "--disable-gpu"],
      cwd: rootDir,
      env: launchEnv
    });

    try {
      const page = await app.firstWindow();
      expect(Date.now() - startedAt).toBeLessThan(3500);
      await expect(page.locator('[data-jasmine-startup="loading"]')).toBeVisible();
      const e2eArtifactDir = path.join(rootDir, "test-results", "ui-harness", "e2e");
      await mkdir(e2eArtifactDir, { recursive: true });
      await page.screenshot({ path: path.join(e2eArtifactDir, "startup-cold-launch.png") });

      const repeatedLaunch = spawn(executablePath, [".", "--disable-gpu"], {
        cwd: rootDir,
        env: launchEnv,
        stdio: "ignore",
        windowsHide: true
      });
      await expect(waitForChildExit(repeatedLaunch)).resolves.toBe(0);

      const appPage = await waitForAppShellPage(app, 15_000);
      await expect(appPage.locator(".app-shell")).toBeVisible();
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
      const nativeHistory = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return {
          canGoBack: window?.webContents.navigationHistory.canGoBack() ?? false,
          entries: window?.webContents.navigationHistory.getAllEntries().length ?? 0
        };
      });
      expect(nativeHistory).toEqual({ canGoBack: false, entries: 1 });

      // Regression: a mouse back button maps to the native navigation history.
      // It must not reveal the temporary startup data URL.
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window?.webContents.navigationHistory.canGoBack()) {
          window.webContents.navigationHistory.goBack();
        }
      });
      await expect(appPage.locator(".app-shell")).toBeVisible();
      await expect(appPage.locator("[data-jasmine-startup]")).toHaveCount(0);
    } finally {
      await quitElectron(app);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("hydrates persisted startup configuration before the first app shell frame", async () => {
    const userDataDir = path.join(rootDir, ".tmp", "e2e", `startup-settings-${randomUUID()}`);
    await rm(userDataDir, { recursive: true, force: true });
    await mkdir(userDataDir, { recursive: true });
    const executablePath = resolveElectronExecutable();
    const baseEnv = baseLaunchEnv(userDataDir, { JASMINE_E2E_HARNESS: "1" });
    const firstApp = await electron.launch({
      executablePath,
      args: [".", "--disable-gpu"],
      cwd: rootDir,
      env: baseEnv
    });

    try {
      const firstPage = await waitForAppShellPage(firstApp, 15_000);
      await firstPage.evaluate(async () => {
        const settings = await window.jasmine.updateAppSettings({
          language: "zh",
          appearance: {
            accent: "#0b74de",
            surface: "#fffdf7",
            ink: "#15191f",
            success: "#008f4c",
            danger: "#d13326"
          },
          toolModel: {
            providerId: "moonshot",
            modelId: "kimi-k2.6",
            reasoningEffort: "minimal"
          }
        });
        window.localStorage.setItem("jasmine.appSettings.startup", JSON.stringify(settings));
      });
    } finally {
      await quitElectron(firstApp);
    }

    const secondStartedAt = Date.now();
    const secondApp = await electron.launch({
      executablePath,
      args: [".", "--disable-gpu"],
      cwd: rootDir,
      env: {
        ...baseEnv,
        JASMINE_STARTUP_DELAY_MS: "800",
        JASMINE_E2E_APP_SETTINGS_DELAY_MS: "5000"
      }
    });

    try {
      const startupPage = await secondApp.firstWindow();
      await expect(startupPage.locator('[data-jasmine-startup="loading"]')).toHaveText("");
      await expect(startupPage.locator(".app-shell")).toHaveCount(0);

      const appPage = await waitForAppShellPage(secondApp, 15_000);
      // Budget must stay below JASMINE_E2E_APP_SETTINGS_DELAY_MS (5000) to prove the
      // shell first frame does not wait on the settings IPC; 4000 absorbs Electron
      // launch overhead on slower machines per user-approved budget.
      expect(Date.now() - secondStartedAt).toBeLessThan(4000);
      const snapshot = await appPage.locator(".app-shell").evaluate((shell) => {
        const rootStyle = getComputedStyle(document.documentElement);
        return {
          text: shell.textContent ?? "",
          accent: rootStyle.getPropertyValue("--accent").trim(),
          surface: rootStyle.getPropertyValue("--surface").trim(),
          language: document.documentElement.lang,
          workspaceLoading: Boolean(shell.querySelector("[data-jasmine-workspace-startup]"))
        };
      });
      expect(snapshot).toMatchObject({
        accent: "#0b74de",
        surface: "#fffdf7",
        language: "zh-CN"
      });
      expect(snapshot.workspaceLoading || snapshot.text.includes("\u8f93\u5165\u6d88\u606f...")).toBe(true);
      expect(snapshot?.text).not.toContain("Talk to yourself.");
      expect(snapshot?.text).not.toContain("Type something. Anything.");
      // Each getAppSettings IPC is artificially delayed by
      // JASMINE_E2E_APP_SETTINGS_DELAY_MS (5000), so the poll timeout must
      // exceed one full round trip; the default 5s expect timeout cannot.
      await expect.poll(
        () => appPage.evaluate(async () => (await window.jasmine.getAppSettings()).toolModel),
        { timeout: 15_000 }
      ).toMatchObject({
        providerId: "moonshot",
        modelId: "kimi-k2.6",
        reasoningEffort: "minimal"
      });
    } finally {
      await quitElectron(secondApp);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("upgrades the original MCP table before app settings hydrate and survives restart", async () => {
    const userDataDir = path.join(rootDir, ".tmp", "e2e", `legacy-mcp-startup-${randomUUID()}`);
    const dataDir = path.join(userDataDir, "data");
    await rm(userDataDir, { recursive: true, force: true });
    await mkdir(dataDir, { recursive: true });
    const legacyDb = new DatabaseSync(path.join(dataDir, "jasmine.sqlite"));
    try {
      legacyDb.exec(`
        CREATE TABLE mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          command TEXT NOT NULL,
          args_json TEXT NOT NULL,
          env_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO mcp_servers (id, name, command, args_json, env_json, enabled, created_at, updated_at)
        VALUES ('legacy-mcp', 'Legacy MCP', 'legacy-command', '["--stdio"]', '{}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `);
    } finally {
      legacyDb.close();
    }

    const launch = async () => electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [".", "--disable-gpu"],
      cwd: rootDir,
      env: baseLaunchEnv(userDataDir, { JASMINE_E2E_HARNESS: "1" })
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const app = await launch();
      try {
        const page = await waitForAppShellPage(app, 20_000);
        const hydrated = await page.evaluate(async () => {
          const [settings, servers] = await Promise.all([
            window.jasmine.getAppSettings(),
            window.jasmine.listMcpServers()
          ]);
          return {
            language: settings.language,
            servers: servers.map((server) => ({
              id: server.id,
              description: server.description,
              transport: server.transport,
              source: server.source,
              marketplaceId: server.marketplaceId ?? null
            }))
          };
        });
        expect(hydrated.language).toBe("en");
        expect(hydrated.servers).toContainEqual({
          id: "legacy-mcp",
          description: "",
          transport: "stdio",
          source: "manual",
          marketplaceId: null
        });
      } finally {
        await quitElectron(app);
      }
    }

    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });
});

// Static config assertions live outside the harness describe so they do not
// pay for an Electron launch in beforeEach.
test.describe("Jasmine static configuration", () => {
  test("dev server config fails instead of silently switching Electron ports", async () => {
    const config = await readFile(path.join(rootDir, "vite.config.ts"), "utf8");

    expect(config).toContain("port: 5173");
    expect(config).toContain("strictPort: true");
  });
});
