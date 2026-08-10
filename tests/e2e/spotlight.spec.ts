import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

type SpotlightHarness = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
};

test.describe("Spotlight quick launcher", () => {
  test("searches threads and routes commands to the main window", async () => {
    const harness = await launchJasmine("spotlight");
    const { app, page } = harness;

    try {
      // Seed a thread so "recent" and search have data.
      const threadId = await page.evaluate(async () => {
        const thread = await window.jasmine.createThread({ title: "Spotlight Alpha Thread" });
        return thread.id;
      });
      expect(threadId).toBeTruthy();

      // Open the Spotlight window (global shortcut cannot be sent in headless Playwright).
      await showSpotlight(app);
      const spotlight = await waitForSpotlightPage(app, 10_000);

      await expectOffscreenWindowsToStayInBackground(app);

      // Card renders and the input is focused.
      await expect(spotlight.locator(".spotlight-card")).toBeVisible();
      await expect(spotlight.locator(".spotlight-input input")).toBeFocused();

      // Empty query shows fixed commands + recent threads.
      await expect(spotlight.locator('.command-menu-row:has-text("New Chat")')).toBeVisible();
      await expect(spotlight.locator('.command-menu-row:has-text("Spotlight Alpha Thread")')).toBeVisible();

      await mkdir(path.join(rootDir, "test-results", "ui-harness", "e2e"), { recursive: true });
      await spotlight.locator(".spotlight-card").screenshot({
        path: path.join(rootDir, "test-results", "ui-harness", "e2e", "spotlight-launcher.png")
      });

      // Typing filters to the matching thread.
      await spotlight.locator(".spotlight-input input").fill("Alpha");
      await expect(spotlight.locator('.command-menu-row:has-text("Spotlight Alpha Thread")')).toBeVisible();

      // Executing the thread row routes the main window to that thread.
      await spotlight.locator('.command-menu-row:has-text("Spotlight Alpha Thread")').click();
      await expect.poll(async () =>
        page.evaluate(() => window.__jasmineHarness?.snapshot()?.app?.navigation?.path ?? "")
      ).toContain(threadId);

      // Spotlight hides after executing a command.
      await expect.poll(() => isSpotlightVisible(app)).toBe(false);

      // Re-open and run "Provider Settings": opens the settings surface.
      await showSpotlight(app);
      const spotlight2 = await waitForSpotlightPage(app, 10_000);
      await spotlight2.locator(".spotlight-input input").fill("Provider");
      await spotlight2.locator('.command-menu-row:has-text("Provider Settings")').click();
      await expect.poll(async () =>
        page.evaluate(() => window.__jasmineHarness?.snapshot()?.surfaces ?? [])
      ).toContain("settings");

      // Re-open and run "New Chat": closes settings and returns to a chat route.
      await showSpotlight(app);
      const spotlight3 = await waitForSpotlightPage(app, 10_000);
      await spotlight3.locator('.command-menu-row:has-text("New Chat")').click();
      await expect.poll(async () =>
        page.evaluate(() => window.__jasmineHarness?.snapshot()?.surfaces ?? [])
      ).not.toContain("settings");
      await expect.poll(async () =>
        page.evaluate(() => window.__jasmineHarness?.snapshot()?.app?.navigation?.path ?? "")
      ).toContain("/chats/");
      await expect(page.locator(".rich-composer-editor")).toBeFocused();
      await page.keyboard.type("spotlight focus draft");
      await expect(page.locator(".rich-composer-editor")).toContainText("spotlight focus draft");
    } finally {
      await quitJasmine(app);
      await app.close().catch(() => undefined);
      await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("routes commands and reopens the main window after it is closed to the tray", async () => {
    const harness = await launchJasmine("spotlight-after-close");
    const { app, page } = harness;

    try {
      // Seed a thread so the spotlight has a routable target.
      const threadId = await page.evaluate(async () => {
        const thread = await window.jasmine.createThread({ title: "Tray Reopen Thread" });
        return thread.id;
      });
      expect(threadId).toBeTruthy();

      // Close the window via the title-bar control; it must hide to the tray,
      // not destroy the window or quit the app.
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect
        .poll(() => app.evaluate(() => Boolean((globalThis as Record<string, any>).__jasmineTray?.isMainAlive?.())))
        .toBe(true);
      await expect
        .poll(() => app.evaluate(() => Boolean((globalThis as Record<string, any>).__jasmineTray?.isMainVisible?.())))
        .toBe(false);

      // The global launcher still works while the window is hidden, and routing
      // a command must reopen and focus the main window on that thread.
      await showSpotlight(app);
      const spotlight = await waitForSpotlightPage(app, 10_000);
      const routeBeforeClick = await page.evaluate(() => window.__jasmineHarness?.snapshot()?.app?.navigation?.path ?? "");
      await clickSpotlightChrome(spotlight);
      await expect
        .poll(() => app.evaluate(() => Boolean((globalThis as Record<string, any>).__jasmineTray?.isMainVisible?.())))
        .toBe(false);
      await expect.poll(async () =>
        page.evaluate(() => window.__jasmineHarness?.snapshot()?.app?.navigation?.path ?? "")
      ).toBe(routeBeforeClick);
      await expect.poll(() => isSpotlightVisible(app)).toBe(true);

      await spotlight.locator('.command-menu-row:has-text("Tray Reopen Thread")').click();

      await expect
        .poll(() => app.evaluate(() => Boolean((globalThis as Record<string, any>).__jasmineTray?.isMainVisible?.())))
        .toBe(true);
      await expect.poll(async () =>
        page.evaluate(() => window.__jasmineHarness?.snapshot()?.app?.navigation?.path ?? "")
      ).toContain(threadId);
      await expect.poll(() => isSpotlightVisible(app)).toBe(false);
    } finally {
      await quitJasmine(app);
      await app.close().catch(() => undefined);
      await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("regular app open hides an already visible launcher", async () => {
    const harness = await launchJasmine("spotlight-open-main");
    const { app, page } = harness;

    try {
      await showSpotlight(app);
      const spotlight = await waitForSpotlightPage(app, 10_000);
      await expect(spotlight.locator(".spotlight-card")).toBeVisible();

      await app.evaluate(() => {
        const hook = (globalThis as { __jasmineTray?: { openMain(): void } }).__jasmineTray;
        hook?.openMain();
      });

      await expect.poll(() => isSpotlightVisible(app)).toBe(false);
      await expect(page.locator(".app-shell")).toBeVisible();
      await expect
        .poll(() => app.evaluate(() => Boolean((globalThis as Record<string, any>).__jasmineTray?.isMainVisible?.())))
        .toBe(true);
    } finally {
      await quitJasmine(app);
      await app.close().catch(() => undefined);
      await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("closes on Escape without losing the main window", async () => {
    const harness = await launchJasmine("spotlight-escape");
    const { app, page } = harness;

    try {
      await showSpotlight(app);
      const spotlight = await waitForSpotlightPage(app, 10_000);
      await expect(spotlight.locator(".spotlight-card")).toBeVisible();
      await spotlight.locator(".spotlight-input input").press("Escape");
      await expect.poll(() => isSpotlightVisible(app)).toBe(false);
      await expect(page.locator(".app-shell")).toBeVisible();
    } finally {
      await quitJasmine(app);
      await app.close().catch(() => undefined);
      await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

async function showSpotlight(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const hook = (globalThis as { __jasmineSpotlight?: { show(): void } }).__jasmineSpotlight;
    hook?.show();
  });
}

async function quitJasmine(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const hook = (globalThis as { __jasmineTray?: { quit(): void } }).__jasmineTray;
    hook?.quit();
  }).catch(() => undefined);
}

async function clickSpotlightChrome(spotlight: Page): Promise<void> {
  const box = await spotlight.locator(".spotlight-card").boundingBox();
  if (!box) throw new Error("Spotlight card bounds were unavailable.");
  await spotlight.mouse.click(box.x + box.width - 12, box.y + 24);
}

async function isSpotlightVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((win) => {
      const url = win.webContents.getURL();
      return url.includes("spotlight.html") && win.isVisible();
    })
  );
}

async function waitForSpotlightPage(app: ElectronApplication, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (candidate.url().includes("spotlight.html") && (await candidate.locator(".spotlight-card").count())) {
        return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diag = await app.evaluate(({ BrowserWindow }) => ({
    hasGlobal: Boolean((globalThis as { __jasmineSpotlight?: unknown }).__jasmineSpotlight),
    urls: BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), visible: w.isVisible() }))
  }));
  throw new Error(`Spotlight window did not appear. diag=${JSON.stringify(diag)}`);
}

function resolveElectronExecutable(): string {
  return path.join(
    rootDir,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron"
  );
}

async function launchJasmine(label: string): Promise<SpotlightHarness> {
  const userDataDir = path.join(rootDir, ".tmp", "e2e", `${label}-${randomUUID()}`);
  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });
  const app = await electron.launch({
    executablePath: resolveElectronExecutable(),
    args: [".", "--disable-gpu"],
    cwd: rootDir,
    env: {
      ...process.env,
      JASMINE_E2E_USER_DATA_DIR: userDataDir,
      JASMINE_E2E_HARNESS: "1",
      JASMINE_E2E_MOCK_AI: "1",
      DEEPSEEK_API_KEY: "e2e-mock-key",
      KIMI_API_KEY: "e2e-mock-key"
    }
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell");
  return { app, page, userDataDir };
}

async function expectOffscreenWindowsToStayInBackground(app: ElectronApplication): Promise<void> {
  if (process.env.JASMINE_E2E_OFFSCREEN !== "1") return;
  const states = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({
      focusable: win.isFocusable(),
      opacity: win.getOpacity(),
      alwaysOnTop: win.isAlwaysOnTop()
    }))
  );
  expect(states.length).toBeGreaterThanOrEqual(2);
  expect(states.every((state) => !state.focusable && state.opacity === 0 && !state.alwaysOnTop)).toBe(true);
}
