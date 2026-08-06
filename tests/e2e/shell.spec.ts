import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  baseLaunchEnv,
  clickCenter,
  createExternalSkillFixture,
  createPiPluginFixture,
  createProjectFolderFixture,
  createPromptTemplateFixture,
  createRedSquarePng,
  createSshConfigFixture,
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

  test("sidebar TODO shortcut stays a compact pinned row below the top actions", async () => {
    const { page } = harness;

    const measureTodoRow = async () => {
      const row = await page.locator(".sidebar-feature-row").boundingBox();
      const top = await page.locator(".side-top").boundingBox();
      const projectsHeading = await page.locator(".sidebar-section-heading").first().boundingBox();
      expect(row).toBeTruthy();
      expect(top).toBeTruthy();
      expect(projectsHeading).toBeTruthy();
      return { row: row!, top: top!, projectsHeading: projectsHeading! };
    };

    const assertCompactPinnedRow = (measured: Awaited<ReturnType<typeof measureTodoRow>>) => {
      // The row itself must stay a slim menu row.
      expect(measured.row.height).toBeLessThanOrEqual(44);
      // It must sit directly under the top action bar.
      expect(measured.row.y - (measured.top.y + measured.top.height)).toBeLessThanOrEqual(12);
      // And Projects must follow immediately below it: a large gap means the
      // feature area absorbed the sidebar's flexible row and the shortcut is
      // floating over empty space.
      const gapToProjects = measured.projectsHeading.y - (measured.row.y + measured.row.height);
      expect(gapToProjects).toBeGreaterThanOrEqual(-1);
      expect(gapToProjects).toBeLessThanOrEqual(32);
    };

    // Idle state with an almost-empty thread list: the shortcut must sit
    // directly under the top action bar, not float mid-sidebar.
    assertCompactPinnedRow(await measureTodoRow());

    // Active state: opening /todo highlights the row but must not stretch it
    // into a filler block that pushes Projects/Chats down.
    await page.getByRole("button", { name: "TODO" }).click();
    await expect(page.locator(".todo-page")).toBeVisible();
    assertCompactPinnedRow(await measureTodoRow());
    await expect(page.locator(".sidebar-feature-row.active")).toBeVisible();

    await mkdir(path.join(rootDir, "test-results", "ui-harness", "e2e"), { recursive: true });
    await page.locator(".sidebar").screenshot({
      path: path.join(rootDir, "test-results", "ui-harness", "e2e", "sidebar-todo-pinned-row.png")
    });
  });

  test("captures TODOs into markdown files from the sidebar surface", async () => {
    const { page, userDataDir } = harness;
    const todoText = "Read DingTalk groups and summarize action items\n[image](local-test.png)";
    const todoSummary = "Read DingTalk groups and summarize action items [image](local-test.png)";

    await page.getByRole("button", { name: "TODO" }).click();
    await expect(page.locator(".todo-page")).toBeVisible();
    await expect.poll(async () =>
      page.evaluate(() => window.__jasmineHarness?.snapshot()?.app?.navigation?.path ?? "")
    ).toBe("/todo");

    await page.getByRole("button", { name: "Add TODO" }).click();
    const todoInput = page.getByRole("textbox", { name: "TODO text" });
    await expect(todoInput).toBeFocused();
    await todoInput.fill(todoText);
    await page.getByRole("button", { name: "Save TODO" }).click();

    await expect(page.locator(".todo-section-list")).toContainText("Read DingTalk groups");
    await page.getByRole("tab", { name: "Log" }).click();
    await expect(page.locator(".todo-log")).toContainText("Read DingTalk groups");
    await mkdir(path.join(rootDir, "test-results", "ui-harness", "e2e"), { recursive: true });
    await page.locator(".todo-page").screenshot({
      path: path.join(rootDir, "test-results", "ui-harness", "e2e", "todo-markdown-surface.png")
    });

    const todoMarkdown = await readFile(path.join(userDataDir, "todos", "todo.md"), "utf8");
    const logMarkdown = await readFile(path.join(userDataDir, "todos", "log.md"), "utf8");
    const schemaMarkdown = await readFile(path.join(userDataDir, "todos", "schema.md"), "utf8");
    expect(todoMarkdown).toContain(`- [ ] ${todoSummary}`);
    expect(logMarkdown).toContain("> Read DingTalk groups and summarize action items");
    expect(logMarkdown).toContain("> [image](local-test.png)");
    expect(schemaMarkdown).toContain("Jasmine TODO Schema");

    await page.getByRole("button", { name: "Open todo.md" }).click();
    await expect.poll(async () =>
      readFile(path.join(userDataDir, "editor-open.log"), "utf8").catch(() => "")
    ).toContain(path.join(userDataDir, "todos", "todo.md"));
  });

  test("window controls maximize, restore, and minimize", async () => {
    const { app, page } = harness;

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

  test("window controls stay available and functional on the TODO route", async () => {
    const { app, page, userDataDir } = harness;

    await page.getByRole("button", { name: "TODO" }).click();
    await expect(page.locator(".todo-page")).toBeVisible();

    // Title-bar chrome is shell-owned, so leaving the chat route must not
    // drop the window controls or the drag strip (UI-FIXED-126).
    await expect(page.getByRole("button", { name: "Minimize" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
    await expect(page.locator(".window-drag-region")).toHaveCount(1);

    await clickCenter(page.getByRole("button", { name: "Maximize" }));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(true);
    await clickCenter(page.getByRole("button", { name: "Restore" }));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized())).toBe(false);

    const refreshButton = page.getByRole("button", { name: "Refresh" });
    await expect(refreshButton).toBeEnabled();

    const refreshedTodoText = "Refresh click reached todo snapshot";
    await writeFile(path.join(userDataDir, "todos", "todo.md"), `# TODO\n\n## Inbox\n\n- [ ] ${refreshedTodoText}\n`, "utf8");

    // Header actions must sit fully below the 44px caption strip; otherwise
    // clicks in their upper half start a window drag instead of the action.
    const refreshBox = await refreshButton.boundingBox();
    expect(refreshBox).toBeTruthy();
    expect(refreshBox!.y).toBeGreaterThanOrEqual(44);
    await clickCenter(refreshButton);
    await expect(page.locator(".todo-section-list")).toContainText(refreshedTodoText);

    await mkdir(path.join(rootDir, "test-results", "ui-harness", "e2e"), { recursive: true });
    await page.screenshot({
      path: path.join(rootDir, "test-results", "ui-harness", "e2e", "todo-window-controls.png")
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

  test("tools menu shows always-on Pi tools and plugins", async () => {
    const { page } = harness;

    await page.locator(".composer").getByRole("button", { name: "Tools" }).click();
    await expect(page.locator(".tools-menu")).toBeVisible();
    await expect(page.locator(".tools-menu")).toContainText("Pi tools");
    await expect(page.locator(".tools-menu")).toContainText("Plugins");
    await expect(page.locator(".tools-menu-row")).toHaveCount(2);
    await expect(page.locator(".tools-menu-row").first().locator(".tools-menu-state .icon")).toHaveCount(1);
    await expect(page.locator(".tools-menu").getByRole("menuitemcheckbox")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".tools-menu")).toBeHidden();
  });

  test("settings open and close from the side menu @smoke", async () => {
    const { page } = harness;

    await openSettings(page);
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

    await page.locator(".side-top").getByRole("button", { name: "New chat" }).click();
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

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(1420, 920);
    });
    await expect.poll(() => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))).toEqual({ width: 1420, height: 920 });
    await expect(page.locator(".window-drag-region")).toHaveCSS("-webkit-app-region", "drag");
    await expect(page.getByRole("button", { name: "Maximize" })).toHaveCSS("-webkit-app-region", "no-drag");

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
    await page.getByRole("button", { name: "Maximize" }).click();
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

  test("window close minimizes to the tray and only tray exit quits the app", async () => {
    await harness.page.getByRole("button", { name: "Close", exact: true }).click();
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
