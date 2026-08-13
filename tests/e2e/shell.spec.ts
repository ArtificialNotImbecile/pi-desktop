import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  baseLaunchEnv,
  clickCenter,
  closeWindowFromTitleBar,
  createExternalSkillFixture,
  createPiPluginFixture,
  createProjectFolderFixture,
  createPromptTemplateFixture,
  createRedSquarePng,
  expectComposerDraft,
  expectComposerEditorText,
  expectEmptyChatClearOfRightPanel,
  expectExecutablePathMetadata,
  expectFloatingMenuInViewport,
  expectModelMenuAnchored,
  expectNoPurpleThemeColors,
  expectSettingsSaved,
  expectSurfaceInViewport,
  expectToolbarHasNoOverlap,
  launchJasmine,
  messageJumpMarkAlignment,
  modelMenuGeometry,
  navigationPath,
  openMemoryFromCommandPalette,
  openProviderSettings,
  openSettings,
  quitElectron,
  resolveElectronExecutable,
  rootDir,
  saveProvider,
  saveSettings,
  seedLargeThreadMessages,
  seedMarkdownThreadMessages,
  seedPiAgentPackageSettings,
  stableChatLayoutSnapshot,
  startEmptyThread,
  testProvider,
  type HarnessApp,
  waitForAppShellPage,
  waitForChildExit,
  waitForStableAssistant
} from "./helpers";

test.describe("Jasmine app shell", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("opens the shell and exercises its basic surfaces @smoke", async () => {
    const { app, page } = harness;

    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator(".chat-page")).toBeVisible();
    await expect(page.locator(".rich-composer-editor")).toBeVisible();
    await expect(page.locator(".composer textarea")).toHaveCount(0);

    // The structured harness describes this same initial shell. Keep its audit
    // and action/snapshot wiring in the smoke launch instead of paying for a
    // second Electron process that reconstructs the identical state.
    await expect.poll(() => page.evaluate(() => Boolean((window as Window & { __jasmineHarness?: unknown }).__jasmineHarness))).toBe(true);
    const initialAudit = await page.evaluate(() => (window as Window & {
      __jasmineHarness: {
        audit(): {
          errorCount: number;
          warningCount: number;
          snapshot: {
            controls: Array<{ label: string; disabled: boolean; disabledReason: string }>;
            surfaces: string[];
          };
        };
      };
    }).__jasmineHarness.audit());
    expect(initialAudit.errorCount).toBe(0);
    expect(initialAudit.snapshot.controls.some((control) => control.label === "Message draft")).toBe(true);
    expect(initialAudit.snapshot.controls.some((control) => control.label === "Send" && control.disabled && control.disabledReason.length > 0)).toBe(true);

    await page.evaluate(() => (window as Window & {
      __jasmineHarness: { actions: { openSettings(): void } };
    }).__jasmineHarness.actions.openSettings());
    await expect(page.locator(".settings-panel")).toBeVisible();
    const settingsSnapshot = await page.evaluate(() => (window as Window & {
      __jasmineHarness: {
        snapshot(): {
          surfaces: string[];
          controls: Array<{ label: string; selector: string }>;
        };
      };
    }).__jasmineHarness.snapshot());
    expect(settingsSnapshot.surfaces).toContain("settings");
    expect(settingsSnapshot.controls.some((control) => control.label === "Close settings")).toBe(true);
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator(".settings-panel")).toBeHidden();

    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);

    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator(".side-menu")).toBeVisible();
    await page.locator(".side-top").getByRole("button", { name: "Search" }).click();
    await expect(page.locator(".search-backdrop")).toBeVisible();
    await expect(page.locator(".side-menu")).toBeHidden();
    await page.getByPlaceholder("Search chats").fill("Greeting");
    await page.keyboard.press("Enter");
    await expect(page.locator(".search-backdrop")).toBeHidden();
    await expect(page.locator(".chat-header")).toContainText("Greeting");
    await expect(page.locator(".side-top").getByRole("button")).toHaveCount(3);
    await expect(page.locator(".side-top").getByRole("button", { name: "Shortcuts" })).toHaveCount(0);

    await page.keyboard.press("Control+K");
    await expect(page.locator(".command-panel")).toBeVisible();
    await page.getByRole("combobox", { name: "Command palette" }).fill("UI catalog");
    await page.keyboard.press("Enter");
    await expect(page.locator(".command-panel")).toBeHidden();
    await expect(page.getByRole("region", { name: "UI catalog" })).toBeVisible();
    await page.getByRole("region", { name: "UI catalog" }).getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("region", { name: "UI catalog" })).toBeHidden();

    await page.locator(".composer").getByRole("button", { name: "Tools" }).click();
    await expect(page.locator(".tools-menu")).toBeVisible();
    await expect(page.locator(".tools-menu")).toContainText("Pi tools");
    await expect(page.locator(".tools-menu")).toContainText("Packages");
    await expect(page.locator(".tools-menu-row")).toHaveCount(2);
    await expect(page.locator(".tools-menu-row").first().locator(".tools-menu-state .icon")).toHaveCount(1);
    await expect(page.locator(".tools-menu").getByRole("menuitemcheckbox")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".tools-menu")).toBeHidden();

    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator(".side-menu").getByRole("button", { name: /Clear History/i })).toHaveCount(0);
    await page.locator(".side-menu").getByRole("button", { name: "About" }).click();
    await expect(page.locator(".settings-nav button.active")).toContainText("About");
    await expect(page.locator(".settings-detail")).toContainText("Jasmine — The desktop app for Pi");
    await expect.poll(() => navigationPath(page)).toBe("/settings/about");
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator(".settings-panel")).toBeHidden();
    await expect.poll(() => navigationPath(page)).toMatch(/^\/(?:chats|projects)\//);

    // Component tests own the dialog's option/back/custom-answer behavior.
    // Keep the real main -> preload -> hook -> App dialog wiring here.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("askUserQuestion:prompt", {
        id: "e2e-ask-user-question-wiring",
        questions: [{
          id: "answer",
          header: "Answer",
          question: "What answer should be sent back?",
          options: [{ label: "Alpha" }, { label: "Beta" }]
        }]
      });
    });
    const dialog = page.getByRole("dialog", { name: "Questions from assistant" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: "Alpha" }).click();
    await dialog.getByRole("button", { name: "Submit answers" }).click();
    await expect(dialog).toBeHidden();
  });

  test("window controls maximize, restore, and minimize @desktop-session", async () => {
    const { app, page } = harness;

    // macOS draws native traffic lights instead of the in-page control strip,
    // so there is nothing to click; the equivalent contract there is that the
    // native chrome still reaches the renderer through window:state-changed.
    if (process.platform === "darwin") {
      await expect(page.locator(".window-controls")).toHaveCount(0);
      await page.evaluate(() => {
        const scope = window as Window & { __windowStates: Array<{ maximized: boolean }> };
        scope.__windowStates = [];
        window.jasmine.onWindowStateChanged((state) => scope.__windowStates.push(state));
      });
      const lastMaximized = () => page.evaluate(() => {
        const scope = window as Window & { __windowStates: Array<{ maximized: boolean }> };
        return scope.__windowStates.at(-1)?.maximized ?? null;
      });

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize());
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(true);
      await expect.poll(lastMaximized).toBe(true);

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.unmaximize());
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(false);
      await expect.poll(lastMaximized).toBe(false);

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(true);
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        win?.restore();
        win?.focus();
      });
      return;
    }

    await clickCenter(page.getByRole("button", { name: "Maximize" }));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(true);
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
    await clickCenter(page.getByRole("button", { name: "Restore" }));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(false);

    await clickCenter(page.getByRole("button", { name: "Minimize" }));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.restore();
      win?.focus();
    });
  });

  test("window states, settings discoverability, and maximized settings layout stay polished", async () => {
    const { app, page } = harness;

    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return {
        resizable: win?.isResizable(),
        movable: win?.isMovable(),
        minimizable: win?.isMinimizable(),
        maximizable: win?.isMaximizable()
      };
    })).toEqual({ resizable: true, movable: true, minimizable: true, maximizable: true });

    // Clamp to the work area: the OS refuses to size a window past it, so a
    // fixed 1420x920 is unreachable on any smaller display (e.g. a 1440x900 Mac).
    const largeSize = await app.evaluate(({ screen }) => {
      const { workArea } = screen.getPrimaryDisplay();
      return { width: Math.min(1420, workArea.width), height: Math.min(920, workArea.height) };
    });
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(size.width, size.height);
    }, largeSize);
    await expect.poll(() => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))).toEqual(largeSize);
    await expect(page.locator(".window-drag-region")).toHaveCSS("-webkit-app-region", "drag");
    // macOS keeps its native traffic lights, so the self-drawn strip is absent
    // there; every other platform draws and owns the caption buttons.
    if (process.platform === "darwin") {
      await expect(page.locator(".window-controls")).toHaveCount(0);
    } else {
      await expect(page.getByRole("button", { name: "Maximize" })).toHaveCSS("-webkit-app-region", "no-drag");
    }

    await page.evaluate(async () => {
      for (let index = 0; index < 75; index += 1) {
        const thread = await window.jasmine.createThread({ title: `Settings discoverability ${index + 1}` });
        await window.jasmine.updateThreadDraft({ threadId: thread.id, content: `settings draft ${index + 1}` });
      }
    });
    await page.reload();
    await expect(page.locator(".side-settings-row")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator(".side-menu")).toBeVisible();
    await expectFloatingMenuInViewport(page, ".side-menu", ".side-footer .icon-button");
    await expect(page.locator(".side-menu button")).toHaveCount(2);
    await expect(page.locator(".side-menu button .menu-inline-icon")).toHaveCount(2);
    await page.locator(".side-menu").getByRole("button", { name: "Settings" }).click();

    await expect(page.locator(".settings-panel")).toBeVisible();
    const layout = await page.locator(".settings-detail").evaluate((detail) => {
      const detailRect = detail.getBoundingClientRect();
      const content = Array.from(detail.children).find((child) => !child.classList.contains("settings-visually-hidden"));
      const contentRect = content?.getBoundingClientRect();
      return {
        detailWidth: detailRect.width,
        contentWidth: contentRect?.width ?? 0,
        contentLeftGap: (contentRect?.left ?? 0) - detailRect.left,
        contentRightGap: detailRect.right - (contentRect?.right ?? 0)
      };
    });
    expect(layout.detailWidth).toBeGreaterThan(500);
    expect(layout.contentWidth).toBeLessThanOrEqual(862);
    expect(Math.abs(layout.contentLeftGap - layout.contentRightGap)).toBeLessThanOrEqual(80);
  });

  test("empty-chat model menu anchors to its trigger in maximized and restored windows @desktop-session", async () => {
    const { app, page } = harness;

    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.locator(".empty-state")).toBeVisible();
    // Maximize natively rather than through the caption button: this test is
    // about menu anchoring, and macOS has no in-page button to click. It already
    // unmaximizes the same way below.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(true);

    await page.locator(".model-pill").click();
    await expect(page.locator(".model-menu")).toBeVisible();
    let geometry = await modelMenuGeometry(page);
    expectModelMenuAnchored(geometry);
    expect(geometry.menuRight).toBeLessThanOrEqual(geometry.viewportWidth - 4);
    expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.viewportHeight - 4);

    await page.keyboard.press("Escape");
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.unmaximize();
      win?.setSize(920, 660);
    });
    await page.locator(".model-pill").click();
    await expect(page.locator(".model-menu")).toBeVisible();
    geometry = await modelMenuGeometry(page);
    expectModelMenuAnchored(geometry);
    expect(geometry.menuRight).toBeLessThanOrEqual(geometry.viewportWidth - 4);
    expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.viewportHeight - 4);
  });

  test("tray icon, click bindings, and close-to-tray exit stay native", async () => {
    const { app, page } = harness;

    // Windows scales its .ico down on its own and keeps the untouched icon.
    // Keep running the rest of this case there instead of skipping the entire
    // merged tray lifecycle.
    if (process.platform !== "win32") {
      // macOS and most Linux panels render the tray image at its own size, so
      // the 1024px app logo stretched the status item across the whole menu bar.
      const size = await app.evaluate(() =>
        (globalThis as Record<string, any>).__jasmineTray?.iconSize?.() as { width: number; height: number } | null
      );
      expect(size).not.toBeNull();
      expect(size!.width).toBeGreaterThan(0);
      expect(size!.width).toBeLessThanOrEqual(32);
      expect(size!.height).toBeLessThanOrEqual(32);
    }

    // A Windows notification-area icon opens the app on a left click and keeps
    // the menu on the right button, so the app binds those clicks itself. macOS
    // gives its one click to the menu, and binding it here as well opened the
    // window before Open Jasmine could be read.
    const listeners = await app.evaluate(() =>
      (globalThis as Record<string, any>).__jasmineTray?.clickListenerCount?.() as number
    );
    expect(listeners).toBe(process.platform === "darwin" ? 0 : 2);

    await closeWindowFromTitleBar(page);
    // Closing hides the window into the system tray; the app stays resident so
    // global shortcuts and the tray keep working instead of leaving a zombie.
    await expect
      .poll(() => app.evaluate(() => Boolean((globalThis as Record<string, any>).__jasmineTray?.isMainAlive?.())))
      .toBe(true);
    await expect
      .poll(() => app.evaluate(() => Boolean((globalThis as Record<string, any>).__jasmineTray?.isMainVisible?.())))
      .toBe(false);
    // The tray "Exit" action is the only path that truly quits the app.
    const closed = app.waitForEvent("close");
    await app.evaluate(() => (globalThis as Record<string, any>).__jasmineTray?.quit?.());
    await closed;
  });

});
