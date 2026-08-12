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
  enableWebSearchFallback,
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

  test("opens a nonblank shell with the chat composer ready @smoke", async () => {
    const { page } = harness;

    await expect(page.locator(".app-shell")).toBeVisible();
    await expect(page.locator(".chat-page")).toBeVisible();
    await expect(page.locator(".rich-composer-editor")).toBeVisible();
    await expect(page.locator(".composer textarea")).toHaveCount(0);
  });

  test("sidebar toggles between collapsed and expanded", async () => {
    const { page } = harness;

    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(page.locator(".app-shell")).not.toHaveClass(/sidebar-collapsed/);
  });

  test("window controls maximize, restore, and minimize", async () => {
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

  test("search overlay and command palette open and dismiss", async () => {
    const { page } = harness;

    await page.locator(".side-top").getByRole("button", { name: "Search" }).click();
    await expect(page.locator(".search-backdrop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".search-backdrop")).toBeHidden();

    await expect(page.locator(".side-top").getByRole("button")).toHaveCount(3);
    await expect(page.locator(".side-top").getByRole("button", { name: "Shortcuts" })).toHaveCount(0);
    await page.keyboard.press("Control+K");
    await expect(page.locator(".command-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".command-panel")).toBeHidden();
  });

  test("tools menu shows always-on Pi tools and packages", async () => {
    const { page } = harness;

    await page.locator(".composer").getByRole("button", { name: "Tools" }).click();
    await expect(page.locator(".tools-menu")).toBeVisible();
    await expect(page.locator(".tools-menu")).toContainText("Pi tools");
    await expect(page.locator(".tools-menu")).toContainText("Packages");
    await expect(page.locator(".tools-menu-row")).toHaveCount(2);
    await expect(page.locator(".tools-menu-row").first().locator(".tools-menu-state .icon")).toHaveCount(1);
    await expect(page.locator(".tools-menu").getByRole("menuitemcheckbox")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".tools-menu")).toBeHidden();
  });

  test("More menu opens About without exposing bulk history deletion @smoke", async () => {
    const { page } = harness;

    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator(".side-menu").getByRole("button", { name: /Clear History/i })).toHaveCount(0);
    await page.locator(".side-menu").getByRole("button", { name: "About" }).click();
    await expect(page.locator(".settings-nav button.active")).toContainText("About");
    await expect(page.locator(".settings-detail")).toContainText("Jasmine — The desktop app for Pi");
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator(".settings-panel")).toBeHidden();
  });

  test("AskUserQuestion dialog collects batched option and Other answers", async () => {
    const { app, page } = harness;

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("askUserQuestion:prompt", {
        id: "e2e-ask-user-question-batch",
        questions: [
          {
            id: "path",
            header: "Path",
            question: "Which path should the assistant take?",
            options: [
              { label: "Use the fast path", description: "Prefer the existing runtime hook." },
              { label: "Use the full path", description: "Add IPC and UI coverage." }
            ]
          },
          {
            id: "tone",
            header: "Tone",
            question: "How should the answer be framed?",
            options: [
              { label: "Short" },
              { label: "Detailed" }
            ]
          }
        ]
      });
    });

    const dialog = page.getByRole("dialog", { name: "Questions from assistant" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Question 1 of 2");
    await expect(dialog).toContainText("Which path should the assistant take?");
    await expect(dialog).not.toContainText("How should the answer be framed?");
    await expect(dialog.getByRole("button", { name: "Next" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
    await dialog.getByRole("radiogroup", { name: "Which path should the assistant take?" }).getByRole("radio", { name: /Use the full path/ }).click();
    await expect(dialog.getByRole("button", { name: "Next" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog).toContainText("Question 2 of 2");
    await expect(dialog).not.toContainText("Which path should the assistant take?");
    await expect(dialog).toContainText("How should the answer be framed?");
    await expect(dialog.getByRole("button", { name: "Back" })).toBeVisible();
    await dialog.getByRole("button", { name: "Back" }).click();
    await expect(dialog).toContainText("Question 1 of 2");
    await dialog.getByRole("button", { name: "Next" }).click();
    await dialog.getByRole("radiogroup", { name: "How should the answer be framed?" }).getByRole("radio", { name: /Other/ }).click();
    await expect(dialog.getByRole("button", { name: "Submit answers" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Custom answer - Tone" }).fill("Use a typed custom framing.");
    await expect(dialog.getByRole("button", { name: "Submit answers" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Submit answers" }).click();
    await expect(dialog).toBeHidden();

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("askUserQuestion:prompt", {
        id: "e2e-ask-user-question-single",
        questions: [
          {
            id: "answer",
            header: "Answer",
            question: "What answer should be sent back?",
            options: [
              { label: "Alpha" },
              { label: "Beta" }
            ]
          }
        ]
      });
    });

    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Question 1 of 1");
    await dialog.getByRole("radio", { name: /Other/ }).click();
    await expect(dialog.getByRole("button", { name: "Submit answers" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Custom answer - Answer" }).fill("Use a typed custom answer.");
    await expect(dialog.getByRole("button", { name: "Submit answers" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Submit answers" }).click();
    await expect(dialog).toBeHidden();
  });

  test("harness bridge exposes structured UI snapshot and audit", async () => {
    const { page } = harness;

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
  });

  test("navigation route adapter tracks settings, provider, thread, and right-panel targets", async () => {
    const { page } = harness;

    await expect.poll(() => page.evaluate(() => (window as Window & {
      __jasmineHarness?: { snapshot(): { app: { navigation: { path: string } } } };
    }).__jasmineHarness?.snapshot().app.navigation.path ?? "")).toMatch(/^\/(?:chats|projects)\//);

    await page.keyboard.press("Control+K");
    await page.getByRole("combobox", { name: "Command palette" }).fill("provider settings");
    await page.keyboard.press("Enter");
    await expect(page.locator(".settings-panel")).toBeVisible();
    await expect.poll(() => navigationPath(page)).toMatch(/^\/settings\/providers\/[^/]+$/);

    await page.locator(".settings-subnav").getByRole("button", { name: /Moonshot|Kimi/ }).click();
    await expect.poll(() => navigationPath(page)).toBe("/settings/providers/moonshot");

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect.poll(() => navigationPath(page)).toMatch(/^\/(?:chats|projects)\//);

    const routeBeforeNewChat = await navigationPath(page);
    await page.locator(".side-top").getByRole("button", { name: "New chat" }).click();
    // The route keeps pointing at the previous thread for a tick after the
    // click, and the generic /chats/ shape below matches that stale value too,
    // so it cannot be used to synchronize. Wait for the switch to the new draft
    // thread before pinning the right-panel routes to it.
    await expect.poll(() => navigationPath(page)).not.toBe(routeBeforeNewChat);
    await expect.poll(() => navigationPath(page)).toMatch(/^\/(?:chats|projects)\//);
    const currentThreadRoute = await navigationPath(page);

    await page.getByRole("button", { name: "Open Terminal" }).click();
    await expect.poll(() => navigationPath(page)).toBe(`${currentThreadRoute}/right-panel/terminal`);

    await page.getByRole("button", { name: "Open Context taxonomy" }).click();
    await expect.poll(() => navigationPath(page)).toBe(`${currentThreadRoute}/right-panel/context`);
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

  test("empty-chat model menu anchors to its trigger in maximized and restored windows", async () => {
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

  test("the tray icon stays a status-area icon instead of the full-size app logo", async () => {
    // Windows scales its .ico down on its own and keeps the untouched icon.
    test.skip(process.platform === "win32", "Windows sizes tray icons itself");
    // macOS and most Linux panels render the tray image at its own size, so the
    // 1024px app logo stretched the status item across the whole menu bar.
    const size = await harness.app.evaluate(() =>
      (globalThis as Record<string, any>).__jasmineTray?.iconSize?.() as { width: number; height: number } | null
    );
    expect(size).not.toBeNull();
    expect(size!.width).toBeGreaterThan(0);
    expect(size!.width).toBeLessThanOrEqual(32);
    expect(size!.height).toBeLessThanOrEqual(32);
  });

  test("clicking the macOS status item opens its menu instead of the window", async () => {
    // A Windows notification-area icon opens the app on a left click and keeps
    // the menu on the right button, so the app binds those clicks itself. macOS
    // gives its one click to the menu, and binding it here as well opened the
    // window before Open Jasmine could be read.
    const listeners = await harness.app.evaluate(() =>
      (globalThis as Record<string, any>).__jasmineTray?.clickListenerCount?.() as number
    );
    expect(listeners).toBe(process.platform === "darwin" ? 0 : 2);
  });

  test("window close minimizes to the tray and only tray exit quits the app", async () => {
    await closeWindowFromTitleBar(harness.page);
    // Closing hides the window into the system tray; the app stays resident so
    // global shortcuts and the tray keep working instead of leaving a zombie.
    await expect
      .poll(() => harness.app.evaluate(() => Boolean((globalThis as Record<string, any>).__jasmineTray?.isMainAlive?.())))
      .toBe(true);
    await expect
      .poll(() => harness.app.evaluate(() => Boolean((globalThis as Record<string, any>).__jasmineTray?.isMainVisible?.())))
      .toBe(false);
    // The tray "Exit" action is the only path that truly quits the app.
    const closed = harness.app.waitForEvent("close");
    await harness.app.evaluate(() => (globalThis as Record<string, any>).__jasmineTray?.quit?.());
    await closed;
  });

  test("floating surfaces dismiss and do not stack stale overlays", async () => {
    const { page } = harness;

    await page.locator(".model-pill").click();
    await expect(page.locator(".model-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".model-menu")).toBeHidden();

    await page.locator(".model-pill").click();
    await expect(page.locator(".model-menu")).toBeVisible();
    await page.locator(".message-scroll").click({ position: { x: 10, y: 10 } });
    await expect(page.locator(".model-menu")).toBeHidden();

    await page.getByRole("button", { name: "More", exact: true }).click();
    await expect(page.locator(".side-menu")).toBeVisible();
    await page.locator(".side-top").getByRole("button", { name: "Search" }).click();
    await expect(page.locator(".search-backdrop")).toBeVisible();
    await expect(page.locator(".side-menu")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator(".search-backdrop")).toBeHidden();
    await expect(page.locator(".side-menu")).toBeHidden();
  });

  test("motion polish respects reduced-motion while keeping surfaces interactive", async () => {
    const { page } = harness;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    await page.locator(".model-pill").click();
    await expect(page.locator(".model-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".model-menu")).toBeHidden();

    await page.keyboard.press("Control+K");
    await expect(page.locator(".command-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".command-panel")).toBeHidden();

    await page.locator(".side-top").getByRole("button", { name: "Search" }).click();
    await expect(page.locator(".search-backdrop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".search-backdrop")).toBeHidden();
  });
});
