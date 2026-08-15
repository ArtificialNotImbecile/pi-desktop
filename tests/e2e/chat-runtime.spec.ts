import { expect, test } from "@playwright/test";
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
  E2E_USER_DATA_DIR_COMPONENT_MAX_BYTES,
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
  readThreadPiSession,
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
  updateSeededMessageContent,
  waitForAppShellPage,
  waitForChildExit,
  waitForStableAssistant
} from "./helpers";

test.describe("Jasmine chat runtime", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("running live messages stream thinking, show tool starts, and finish tool summaries", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("slow response slow timeline write live render");
    await page.getByRole("button", { name: "Send" }).click();

    const liveAssistant = page.locator(".assistant-block.live-message").last();
    await expect(liveAssistant).toBeVisible();
    await expect(liveAssistant.locator(".run-header.live")).toBeVisible();
    await expect(liveAssistant.locator(".thinking-item")).toContainText("Need to inspect");
    await expect(liveAssistant.locator(".timeline-row-thought")).toHaveCount(0);
    // A running row carries its state as a class and a sweep, never a status
    // word, so the row itself only ever names what the tool is acting on.
    const writeTool = liveAssistant.locator(".tool-run-item", { hasText: "src/example.ts" });
    await expect(writeTool).toHaveClass(/running/);
    await expect(writeTool).not.toContainText("wrote");
    await expect(liveAssistant.locator(".timeline-output")).toContainText("Slow", { timeout: 2000 });
    await expect(liveAssistant.locator(".run-header.live")).toBeVisible();
    await expect(page.locator(".message-actions:visible")).toHaveCount(0);

    const settledAssistant = await waitForStableAssistant(page, "Slow response complete.");
    await expect(settledAssistant.getByLabel("Assistant output")).toContainText("Slow response complete.");
    await expect(page.locator(".run-header.live")).toHaveCount(0);
    const settledHeader = settledAssistant.locator(".run-header-toggle");
    await expect(settledHeader).toContainText("Worked for");
    // A successful run folds its activity away; the answer stays.
    await expect(settledHeader).toHaveAttribute("aria-expanded", "false");
    await expect(settledAssistant.locator(".tool-run-item")).toBeHidden();
    await settledHeader.click();
    const settledWrite = settledAssistant.locator(".tool-run-item", { hasText: "src/example.ts" });
    await expect(settledWrite).toBeVisible();
    await expect(settledWrite).toHaveClass(/done/);
    await expect(settledWrite.locator(".timeline-row-suffix")).toHaveText("+4");
  });

  test("a second run shows Thinking before its first live chunk without repainting settled history", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_FIRST_SETTLEMENT__?: { assistantId: string; renderId: string | null };
        __JASMINE_FIRST_SETTLEMENT_CLEANUP__?: () => void;
      };
      scope.__JASMINE_FIRST_SETTLEMENT_CLEANUP__ = window.jasmine.onChatStream((event) => {
        if (!event.settlement || scope.__JASMINE_FIRST_SETTLEMENT__) return;
        const assistant = event.settlement.messages.find((message) => message.role === "assistant");
        if (assistant) {
          scope.__JASMINE_FIRST_SETTLEMENT__ = {
            assistantId: assistant.id,
            renderId: assistant.renderId ?? null
          };
        }
      });
    });

    await page.locator(".rich-composer-editor").fill("first settled render identity");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await expect.poll(() => page.evaluate(() => Boolean((window as Window & {
      __JASMINE_FIRST_SETTLEMENT__?: { assistantId: string; renderId: string | null };
    }).__JASMINE_FIRST_SETTLEMENT__))).toBe(true);
    const firstSettlement = await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_FIRST_SETTLEMENT__?: { assistantId: string; renderId: string | null };
        __JASMINE_FIRST_SETTLEMENT_CLEANUP__?: () => void;
      };
      scope.__JASMINE_FIRST_SETTLEMENT_CLEANUP__?.();
      return scope.__JASMINE_FIRST_SETTLEMENT__;
    });
    expect(firstSettlement).toBeDefined();
    expect(firstSettlement?.renderId).toMatch(/^stream-/);

    await page.evaluate((assistantId) => {
      const scope = window as Window & {
        __JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__?: Record<string, number>;
        __JASMINE_FIRST_ASSISTANT_NODE__?: Element;
        __JASMINE_SECOND_RUN_MONITOR__?: {
          settlementSeen: boolean;
          sampledFrames: number;
          postSettlementActivityInsertions: number;
        };
        __JASMINE_SECOND_RUN_CLEANUP__?: () => void;
      };
      const firstAssistant = document.querySelector(`[data-message-id="${CSS.escape(assistantId)}"]`);
      if (!firstAssistant) throw new Error("The first settled assistant is missing.");
      scope.__JASMINE_FIRST_ASSISTANT_NODE__ = firstAssistant;
      scope.__JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__ = {};

      const monitor = {
        settlementSeen: false,
        sampledFrames: 0,
        postSettlementActivityInsertions: 0
      };
      scope.__JASMINE_SECOND_RUN_MONITOR__ = monitor;
      const activitySelector = ".run-header.live";
      const containsTurnActivity = (node: Node) => node instanceof Element && (
        node.matches(activitySelector) || Boolean(node.querySelector(activitySelector))
      );
      const observer = new MutationObserver((records) => {
        if (!monitor.settlementSeen) return;
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!containsTurnActivity(node)) continue;
            monitor.postSettlementActivityInsertions += 1;
          }
        }
      });
      observer.observe(document.querySelector(".message-stack") ?? document.body, { childList: true, subtree: true });
      const unsubscribe = window.jasmine.onChatStream((event) => {
        if (!event.settlement || monitor.settlementSeen) return;
        monitor.settlementSeen = true;
        const sample = () => {
          monitor.sampledFrames += 1;
          if (monitor.sampledFrames < 8) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      scope.__JASMINE_SECOND_RUN_CLEANUP__ = () => {
        observer.disconnect();
        unsubscribe();
      };
    }, firstSettlement!.assistantId);

    await page.locator(".rich-composer-editor").fill("slow response slow timeline second run placeholder boundary");
    const historicalUserEdit = page.locator(".user-message-wrap").first()
      .getByRole("button", { name: "Edit message", includeHidden: true });
    const historicalRetry = page.locator(".assistant-block").first()
      .getByRole("button", { name: "Regenerate this response", includeHidden: true });
    await page.locator(".assistant-block").first().getByRole("button", { name: "Message actions" }).click();
    await expect(page.locator(".message-menu")).toBeVisible();
    await page.evaluate(() => {
      const scope = window as Window & {
        __JASMINE_BUSY_MENU_STATE__?: { count: number; allDisabled: boolean };
      };
      const scroll = document.querySelector(".message-scroll");
      if (!scroll) throw new Error("Message scroll is missing.");
      const observer = new MutationObserver(() => {
        if (!scroll.classList.contains("is-running")) return;
        const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".message-menu .ui-menu-item"));
        scope.__JASMINE_BUSY_MENU_STATE__ = {
          count: items.length,
          allDisabled: items.every((item) => item.disabled)
        };
        observer.disconnect();
      });
      observer.observe(scroll, { attributes: true, attributeFilter: ["class"] });
    });
    // A synthetic submit does not send the pointer-down that normally closes a
    // floating menu. Starting the run itself must close and disable that portal.
    await page.getByRole("button", { name: "Send" }).evaluate((button: HTMLButtonElement) => button.click());

    // The mock provider waits 750ms before publishing its first live chunk. The
    // prior settled answer still has a stream renderId. The new turn's stable
    // activity line must appear before its first assistant snapshot.
    const turnActivity = page.locator(".run-header.live");
    await expect(turnActivity).toBeVisible({ timeout: 500 });
    await expect(turnActivity).toContainText("Working");
    // The stand-in header is not an assistant message: no assistant block
    // exists until the run's first frame arrives.
    await expect(page.locator(".run-placeholder .run-header.live")).toHaveCount(1);
    await expect(page.locator(".assistant-block.live-message")).toHaveCount(0);
    // Mutation observers run after React's layout effects and before the next
    // paint, so this captures the first busy commit rather than racing the
    // portal's 160ms exit animation through Playwright round trips.
    const busyMenuState = await page.evaluate(() => (
      window as Window & { __JASMINE_BUSY_MENU_STATE__?: { count: number; allDisabled: boolean } }
    ).__JASMINE_BUSY_MENU_STATE__);
    expect(busyMenuState).toEqual({ count: 3, allDisabled: true });

    await expect(page.locator(".assistant-block.live-message").last()).toBeVisible({ timeout: 2_000 });
    await expect(turnActivity).toBeVisible();
    await expect(page.locator(".message-menu")).toBeHidden();
    const userActionRows = page.locator(".user-message-actions");
    const assistantActionRows = page.locator(".message-actions");
    await expect(userActionRows).toHaveCount(2);
    await expect(assistantActionRows).toHaveCount(2);
    await expect(userActionRows.first()).toBeHidden();
    await expect(userActionRows.last()).toBeHidden();
    await expect(assistantActionRows.first()).toBeHidden();
    await expect(assistantActionRows.last()).toBeHidden();
    await expect(historicalUserEdit).toBeDisabled();
    await expect(historicalRetry).toBeDisabled();
    await expect(page.locator(".user-message-actions button")).toHaveCount(2);
    await expect(page.locator(".message-actions > button, .message-actions > .message-more > button")).toHaveCount(6);
    expect(await page.locator(".user-message-actions button, .message-actions > button, .message-actions > .message-more > button")
      .evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled))).toBe(true);
    await historicalUserEdit.evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await historicalRetry.evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await expect(page.locator(".edit-banner")).toHaveCount(0);
    await expect(page.locator(".assistant-block.live-message")).toHaveCount(1);
    await waitForStableAssistant(page, "Slow response complete.", 10_000);
    await expect(historicalUserEdit).toBeEnabled();
    await expect(historicalRetry).toBeEnabled();
    await expect.poll(() => page.evaluate(() => (
      (window as Window & { __JASMINE_SECOND_RUN_MONITOR__?: { sampledFrames: number } })
        .__JASMINE_SECOND_RUN_MONITOR__?.sampledFrames ?? 0
    ))).toBe(8);

    const result = await page.evaluate((assistantId) => {
      const scope = window as Window & {
        __JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__?: Record<string, number>;
        __JASMINE_FIRST_ASSISTANT_NODE__?: Element;
        __JASMINE_SECOND_RUN_MONITOR__?: {
          settlementSeen: boolean;
          sampledFrames: number;
          postSettlementActivityInsertions: number;
        };
        __JASMINE_SECOND_RUN_CLEANUP__?: () => void;
      };
      const monitor = scope.__JASMINE_SECOND_RUN_MONITOR__;
      const sameFirstAssistantNode = scope.__JASMINE_FIRST_ASSISTANT_NODE__
        === document.querySelector(`[data-message-id="${CSS.escape(assistantId)}"]`);
      const firstAssistantRenders = scope.__JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__?.[assistantId] ?? 0;
      scope.__JASMINE_SECOND_RUN_CLEANUP__?.();
      return { ...monitor, sameFirstAssistantNode, firstAssistantRenders };
    }, firstSettlement!.assistantId);

    expect(result.settlementSeen).toBe(true);
    expect(result.postSettlementActivityInsertions).toBe(0);
    expect(result.sameFirstAssistantNode).toBe(true);
    expect(result.firstAssistantRenders).toBe(0);
    await expect(turnActivity).toHaveCount(0);
  });

  test("a first send from an unmaterialized chat keeps its optimistic row through thread selection", async () => {
    const { page } = harness;
    const prompt = "slow response first unmaterialized chat continuity";

    // Opening a project enters /chat/new without materializing a ChatThread.
    // Submit must create/select that thread and stage the user row atomically.
    await page.getByRole("button", { name: "Open Folder..." }).first().click();
    await expect(page.locator(".project-row", { hasText: "local-project" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      (window as Window & {
        __jasmineHarness?: { snapshot(): { app: { activeThreadId: string | null } } };
      }).__jasmineHarness?.snapshot().app.activeThreadId ?? null
    ))).toBeNull();

    await page.evaluate((text) => {
      const stack = document.querySelector(".message-stack");
      if (!stack) throw new Error("Message stack is missing.");
      const scope = window as Window & {
        __JASMINE_FIRST_SEND_CONTINUITY__?: {
          prompt: string;
          sawNode: boolean;
          removals: number;
          firstNode: Element | null;
          observer: MutationObserver;
        };
      };
      const state = {
        prompt: text,
        sawNode: false,
        removals: 0,
        firstNode: null as Element | null,
        observer: null as unknown as MutationObserver
      };
      const findUser = (node: Node): Element | null => {
        if (!(node instanceof Element)) return null;
        const candidate = node.matches(".user-message-wrap")
          ? node
          : node.querySelector(".user-message-wrap");
        return candidate?.textContent?.includes(text) ? candidate : null;
      };
      state.observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const added of record.addedNodes) {
            const user = findUser(added);
            if (user && !state.firstNode) {
              state.firstNode = user;
              state.sawNode = true;
            }
          }
          for (const removed of record.removedNodes) {
            if (state.firstNode && (removed === state.firstNode || removed.contains(state.firstNode))) {
              state.removals += 1;
            }
          }
        }
      });
      state.observer.observe(stack, { childList: true, subtree: true });
      scope.__JASMINE_FIRST_SEND_CONTINUITY__ = state;
    }, prompt);

    await page.locator(".rich-composer-editor").fill(prompt);
    await page.getByRole("button", { name: "Send" }).click();
    const optimisticUser = page.locator(".user-message-wrap", { hasText: prompt });
    await expect(optimisticUser).toBeVisible();
    const optimisticId = await optimisticUser.getAttribute("data-message-id");
    expect(optimisticId).toMatch(/^pending-/);

    await waitForStableAssistant(page, "Slow response complete.");
    await expect(page.locator(".user-message-wrap", { hasText: prompt })).toBeVisible();
    const continuity = await page.evaluate((text) => {
      const scope = window as Window & {
        __JASMINE_FIRST_SEND_CONTINUITY__?: {
          sawNode: boolean;
          removals: number;
          firstNode: Element | null;
          observer: MutationObserver;
        };
      };
      const state = scope.__JASMINE_FIRST_SEND_CONTINUITY__;
      const current = Array.from(document.querySelectorAll(".user-message-wrap"))
        .find((node) => node.textContent?.includes(text));
      state?.observer.disconnect();
      return {
        sawNode: state?.sawNode ?? false,
        removals: state?.removals ?? -1,
        sameNode: Boolean(state?.firstNode && state.firstNode === current && state.firstNode.isConnected)
      };
    }, prompt);
    expect(continuity).toEqual({ sawNode: true, removals: 0, sameNode: true });
    await expect(page.locator(".error-strip")).toBeHidden();
  });

  test("operation-specific pre-chunk abort settlements preserve loaded history and stable DOM identities", async () => {
    const originalUserDataDir = harness.userDataDir;
    await quitElectron(harness.app);
    await rm(originalUserDataDir, { recursive: true, force: true });
    harness = await launchJasmine("abort-settlement-continuity", undefined, {
      JASMINE_E2E_CHAT_GENERATION_DELAY_MS: "1500"
    });
    const { page, userDataDir } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Abort settlement continuity" }));
    seedLargeThreadMessages(userDataDir, thread.id, 620);
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /Abort settlement continuity/ }).click();
    await expect(page.locator(".message-stack [data-message-id]")).toHaveCount(160);

    while (await page.locator(".message-stack [data-message-id]").count() < 620) {
      const before = await page.locator(".message-stack [data-message-id]").count();
      await page.locator(".load-older-messages").click();
      await expect.poll(() => page.locator(".message-stack [data-message-id]").count()).toBeGreaterThan(before);
    }
    await expect(page.locator(".message-stack [data-message-id]")).toHaveCount(620);
    await expect(page.locator(".message-stack [data-message-id]").first()).toHaveAttribute("data-message-id", "large-0000");

    const prompt = "slow response abort before first chunk continuity";
    await page.locator(".rich-composer-editor").fill(prompt);
    await page.getByRole("button", { name: "Send" }).click();
    const optimisticUser = page.locator(".user-message-wrap", { hasText: prompt });
    await expect(optimisticUser).toBeVisible();
    await expect(optimisticUser).toHaveAttribute("data-message-id", /^pending-/);
    await expect(page.locator(".assistant-block.live-message")).toHaveCount(0);

    // Wait only until main has persisted the user row. The mock provider then
    // remains in its 750 ms pre-chunk delay, giving stop a deterministic window.
    await expect.poll(() => page.evaluate(async ({ threadId, content }) => {
      const messages = await window.jasmine.listMessages({ threadId, limit: 1 });
      return messages.at(-1)?.content === content;
    }, { threadId: thread.id, content: prompt }), { timeout: 500, intervals: [10, 20, 20] }).toBe(true);

    await page.evaluate((content) => {
      const scope = window as Window & {
        __JASMINE_ABORT_CONTINUITY__?: {
          firstHistory: Element;
          optimisticUser: Element;
          removals: number;
          settlement: { replaceAfterMessageId: string | null; messageCount: number; renderId: string | null } | null;
          observer: MutationObserver;
          unsubscribe: () => void;
        };
      };
      const firstHistory = document.querySelector("[data-message-id='large-0000']");
      const optimistic = Array.from(document.querySelectorAll(".user-message-wrap"))
        .find((node) => node.textContent?.includes(content));
      const stack = document.querySelector(".message-stack");
      if (!firstHistory || !optimistic || !stack) throw new Error("Continuity fixtures are missing.");
      const state = {
        firstHistory,
        optimisticUser: optimistic,
        removals: 0,
        settlement: null as { replaceAfterMessageId: string | null; messageCount: number; renderId: string | null } | null,
        observer: null as unknown as MutationObserver,
        unsubscribe: () => undefined
      };
      state.observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const removed of record.removedNodes) {
            if (
              removed === state.optimisticUser
              || removed.contains(state.optimisticUser)
              || removed === state.firstHistory
              || removed.contains(state.firstHistory)
            ) state.removals += 1;
          }
        }
      });
      state.observer.observe(stack, { childList: true, subtree: true });
      state.unsubscribe = window.jasmine.onChatStream((event) => {
        if (event.status !== "aborted" || !event.settlement) return;
        state.settlement = {
          replaceAfterMessageId: event.settlement.replaceAfterMessageId ?? null,
          messageCount: event.settlement.messages.length,
          renderId: event.settlement.messages.at(-1)?.renderId ?? null
        };
      });
      scope.__JASMINE_ABORT_CONTINUITY__ = state;
    }, prompt);

    await page.getByRole("button", { name: "Stop response" }).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as Window & {
      __JASMINE_ABORT_CONTINUITY__?: { settlement: unknown };
    }).__JASMINE_ABORT_CONTINUITY__?.settlement))).toBe(true);
    await expect(page.locator(".message-stack [data-message-id]")).toHaveCount(621);
    await expect(page.locator(".message-stack [data-message-id]").first()).toHaveAttribute("data-message-id", "large-0000");

    const continuity = await page.evaluate((content) => {
      const scope = window as Window & {
        __JASMINE_ABORT_CONTINUITY__?: {
          firstHistory: Element;
          optimisticUser: Element;
          removals: number;
          settlement: { replaceAfterMessageId: string | null; messageCount: number; renderId: string | null } | null;
          observer: MutationObserver;
          unsubscribe: () => void;
        };
      };
      const state = scope.__JASMINE_ABORT_CONTINUITY__;
      const currentUser = Array.from(document.querySelectorAll(".user-message-wrap"))
        .find((node) => node.textContent?.includes(content));
      const result = {
        sameFirstHistory: state?.firstHistory === document.querySelector("[data-message-id='large-0000']"),
        sameUser: state?.optimisticUser === currentUser,
        removals: state?.removals ?? -1,
        settlement: state?.settlement ?? null,
        currentUserId: currentUser?.getAttribute("data-message-id") ?? null
      };
      state?.observer.disconnect();
      state?.unsubscribe();
      return result;
    }, prompt);
    expect(continuity.sameFirstHistory).toBe(true);
    expect(continuity.sameUser).toBe(true);
    expect(continuity.removals).toBe(0);
    expect(continuity.currentUserId).not.toMatch(/^pending-/);
    expect(continuity.settlement).toEqual({
      replaceAfterMessageId: "large-0619",
      messageCount: 1,
      renderId: expect.stringMatching(/^pending-/)
    });

    type AbortSettlementSnapshot = {
      replaceAfterMessageId: string | null;
      replaceFromMessageId: string | null;
      messages: Array<{ id: string; renderId: string | null }>;
    };
    const armAbortSettlement = async () => {
      await page.evaluate(() => {
        const scope = window as Window & {
          __JASMINE_OPERATION_ABORT__?: {
            settlement: {
              replaceAfterMessageId: string | null;
              replaceFromMessageId: string | null;
              messages: Array<{ id: string; renderId: string | null }>;
            } | null;
            unsubscribe: () => void;
          };
        };
        scope.__JASMINE_OPERATION_ABORT__?.unsubscribe();
        const state = {
          settlement: null as {
            replaceAfterMessageId: string | null;
            replaceFromMessageId: string | null;
            messages: Array<{ id: string; renderId: string | null }>;
          } | null,
          unsubscribe: () => undefined
        };
        state.unsubscribe = window.jasmine.onChatStream((event) => {
          if (event.status !== "aborted" || !event.settlement) return;
          state.settlement = {
            replaceAfterMessageId: event.settlement.replaceAfterMessageId ?? null,
            replaceFromMessageId: event.settlement.replaceFromMessageId ?? null,
            messages: event.settlement.messages.map((message) => ({
              id: message.id,
              renderId: message.renderId ?? null
            }))
          };
        });
        scope.__JASMINE_OPERATION_ABORT__ = state;
      });
    };
    const takeAbortSettlement = async (): Promise<AbortSettlementSnapshot> => {
      await expect.poll(() => page.evaluate(() => Boolean((window as Window & {
        __JASMINE_OPERATION_ABORT__?: { settlement: unknown };
      }).__JASMINE_OPERATION_ABORT__?.settlement))).toBe(true);
      return page.evaluate(() => {
        const scope = window as Window & {
          __JASMINE_OPERATION_ABORT__?: {
            settlement: AbortSettlementSnapshot | null;
            unsubscribe: () => void;
          };
        };
        const state = scope.__JASMINE_OPERATION_ABORT__;
        state?.unsubscribe();
        if (!state?.settlement) throw new Error("Abort settlement is missing.");
        return state.settlement;
      });
    };

    await armAbortSettlement();
    const retryTarget = page.locator("[data-message-id='large-0619']");
    // The chat follower may still be completing its bounded tail animation;
    // invoke the always-mounted action without waiting for hover stability.
    await retryTarget.getByRole("button", { name: "Regenerate this response" }).click({ force: true });
    await page.getByRole("button", { name: "Stop response" }).click();
    const retrySettlement = await takeAbortSettlement();
    expect(retrySettlement).toEqual({
      replaceAfterMessageId: "large-0618",
      replaceFromMessageId: "large-0619",
      messages: [
        { id: "large-0619", renderId: expect.stringMatching(/^stream-/) },
        { id: continuity.currentUserId, renderId: expect.stringMatching(/^stream-/) }
      ]
    });
    await expect(page.locator(".message-stack [data-message-id]")).toHaveCount(621);
    await expect(page.locator(".message-stack [data-message-id]").first()).toHaveAttribute("data-message-id", "large-0000");
    await expect(page.getByRole("button", { name: "Stop response" })).toHaveCount(0);

    const editedUser = page.locator("[data-message-id='large-0618']");
    await editedUser.evaluate((node) => {
      (window as Window & { __JASMINE_ABORT_EDIT_NODE__?: Element }).__JASMINE_ABORT_EDIT_NODE__ = node;
    });
    await editedUser.getByRole("button", { name: "Edit message" }).click({ force: true });
    await expect(page.locator(".edit-banner")).toContainText("Editing message");
    await page.locator(".rich-composer-editor").fill("edited request aborted before generation");
    await armAbortSettlement();
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Stop response" }).click();
    const editSettlement = await takeAbortSettlement();
    expect(editSettlement).toEqual({
      replaceAfterMessageId: "large-0617",
      replaceFromMessageId: "large-0618",
      messages: [{ id: "large-0618", renderId: null }]
    });
    await expect(page.locator(".message-stack [data-message-id]")).toHaveCount(619);
    expect(await page.evaluate(() => (
      (window as Window & { __JASMINE_ABORT_EDIT_NODE__?: Element }).__JASMINE_ABORT_EDIT_NODE__
      === document.querySelector("[data-message-id='large-0618']")
    ))).toBe(true);
    await expect(page.locator(".error-strip")).toBeHidden();
  });

  test("switching threads never paints the old rows under the new active selection", async () => {
    const { page } = harness;
    const alphaPrompt = "paint switch alpha boundary";
    const betaPrompt = "paint switch beta boundary";

    await startEmptyThread(page);
    await page.locator(".rich-composer-editor").fill(alphaPrompt);
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await startEmptyThread(page);
    await page.locator(".rich-composer-editor").fill(betaPrompt);
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");

    const titles = await page.evaluate(async ({ alpha, beta }) => {
      const threads = await window.jasmine.listThreads();
      const alphaThread = threads.find((thread) => thread.title.includes(alpha));
      const betaThread = threads.find((thread) => thread.title.includes(beta));
      if (!alphaThread || !betaThread) throw new Error("Paint-switch threads are missing.");
      return { alpha: alphaThread.title, beta: betaThread.title };
    }, { alpha: alphaPrompt, beta: betaPrompt });
    await page.getByRole("button", { name: new RegExp(alphaPrompt, "i") }).first().click();
    await expect(page.locator(".message-stack")).toContainText(alphaPrompt);

    await page.evaluate(({ alpha, beta, betaTitle }) => {
      const scope = window as Window & {
        __JASMINE_THREAD_PAINT_MONITOR__?: {
          frames: number;
          mismatchFrames: number;
          betaContentFrames: number;
          finished: boolean;
        };
      };
      const monitor = { frames: 0, mismatchFrames: 0, betaContentFrames: 0, finished: false };
      scope.__JASMINE_THREAD_PAINT_MONITOR__ = monitor;
      const sample = () => {
        monitor.frames += 1;
        const activeTitle = document.querySelector(".thread-row.active .thread-item > span")?.textContent ?? "";
        const stackText = document.querySelector(".message-stack")?.textContent ?? "";
        const betaSelected = activeTitle.includes(betaTitle);
        if (betaSelected && stackText.includes(alpha)) monitor.mismatchFrames += 1;
        if (betaSelected && stackText.includes(beta)) monitor.betaContentFrames += 1;
        if (monitor.betaContentFrames >= 4 || monitor.frames >= 600) {
          monitor.finished = true;
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { alpha: alphaPrompt, beta: betaPrompt, betaTitle: titles.beta });

    await page.getByRole("button", { name: new RegExp(betaPrompt, "i") }).first().click();
    await expect(page.locator(".message-stack")).toContainText(betaPrompt);
    await expect.poll(() => page.evaluate(() => (
      (window as Window & {
        __JASMINE_THREAD_PAINT_MONITOR__?: { finished: boolean };
      }).__JASMINE_THREAD_PAINT_MONITOR__?.finished ?? false
    ))).toBe(true);
    const monitor = await page.evaluate(() => (
      (window as Window & {
        __JASMINE_THREAD_PAINT_MONITOR__?: {
          frames: number;
          mismatchFrames: number;
          betaContentFrames: number;
          finished: boolean;
        };
      }).__JASMINE_THREAD_PAINT_MONITOR__
    ));
    expect(monitor?.betaContentFrames).toBeGreaterThanOrEqual(4);
    expect(monitor?.mismatchFrames).toBe(0);
  });

  test("provider send failures preserve rendered history and cannot write an old thread page into a new selection", async () => {
    const { page } = harness;
    const alphaPrompt = "provider failure alpha history";
    const betaPrompt = "provider failure beta history";
    const stableFailurePrompt = "working failure stable provider reconcile";
    const staleFailurePrompt = "working failure stale provider reconcile";

    await startEmptyThread(page);
    await page.locator(".rich-composer-editor").fill(alphaPrompt);
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await startEmptyThread(page);
    await page.locator(".rich-composer-editor").fill(betaPrompt);
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");

    const ids = await page.evaluate(async ({ alpha, beta }) => {
      const threads = await window.jasmine.listThreads();
      const alphaThread = threads.find((thread) => thread.title.includes(alpha));
      const betaThread = threads.find((thread) => thread.title.includes(beta));
      if (!alphaThread || !betaThread) throw new Error("Provider-failure threads are missing.");
      return { alpha: alphaThread.id, beta: betaThread.id };
    }, { alpha: alphaPrompt, beta: betaPrompt });
    await page.getByRole("button", { name: new RegExp(alphaPrompt, "i") }).first().click();
    await expect(page.locator(".message-stack")).toContainText(alphaPrompt);

    const historyIds = await page.locator(".message-stack [data-message-id]").evaluateAll((nodes) => (
      nodes.map((node) => node.getAttribute("data-message-id")).filter((id): id is string => Boolean(id))
    ));
    expect(historyIds).toHaveLength(2);
    await page.evaluate((messageIds) => {
      const scope = window as Window & {
        __JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__?: Record<string, number>;
        __JASMINE_FAILURE_HISTORY_NODES__?: Element[];
        __JASMINE_FAILURE_USER_NODE__?: Element;
      };
      scope.__JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__ = {};
      scope.__JASMINE_FAILURE_HISTORY_NODES__ = messageIds.map((id) => {
        const node = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
        if (!node) throw new Error(`Historical message ${id} is missing.`);
        return node;
      });
    }, historyIds);

    // Delay only the post-failure database response (after it has read SQLite),
    // leaving time to retain the optimistic node reference before reconciliation.
    await page.evaluate((threadId) => {
      window.__JASMINE_MESSAGE_LOAD_DELAYS__ = { [threadId]: [900] };
    }, ids.alpha);
    await page.locator(".rich-composer-editor").fill(stableFailurePrompt);
    await page.getByRole("button", { name: "Send" }).click();
    const optimisticUser = page.locator(".user-message-wrap", { hasText: stableFailurePrompt });
    await expect(optimisticUser).toBeVisible();
    await optimisticUser.evaluate((node) => {
      (window as Window & { __JASMINE_FAILURE_USER_NODE__?: Element }).__JASMINE_FAILURE_USER_NODE__ = node;
    });
    await expect(page.locator(".assistant-block.error-message")).toContainText("Mock Working failure.");

    const stableResult = await page.evaluate(({ messageIds, prompt }) => {
      const scope = window as Window & {
        __JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__?: Record<string, number>;
        __JASMINE_FAILURE_HISTORY_NODES__?: Element[];
        __JASMINE_FAILURE_USER_NODE__?: Element;
      };
      const historyNodes = scope.__JASMINE_FAILURE_HISTORY_NODES__ ?? [];
      const currentHistory = messageIds.map((id) => document.querySelector(`[data-message-id="${CSS.escape(id)}"]`));
      const currentUser = Array.from(document.querySelectorAll(".user-message-wrap"))
        .find((node) => node.textContent?.includes(prompt));
      return {
        historyRenders: messageIds.map((id) => scope.__JASMINE_MESSAGE_VIEW_RENDERS_BY_ID__?.[id] ?? 0),
        sameHistoryNodes: historyNodes.every((node, index) => node === currentHistory[index] && node.isConnected),
        sameUserNode: Boolean(scope.__JASMINE_FAILURE_USER_NODE__
          && scope.__JASMINE_FAILURE_USER_NODE__ === currentUser
          && scope.__JASMINE_FAILURE_USER_NODE__.isConnected)
      };
    }, { messageIds: historyIds, prompt: stableFailurePrompt });
    expect(stableResult.historyRenders).toEqual([0, 0]);
    expect(stableResult.sameHistoryNodes).toBe(true);
    expect(stableResult.sameUserNode).toBe(true);

    // Exercise the same failure read again, but navigate after it has captured
    // A's page. Its delayed response must fail the epoch/thread guard on B.
    await page.evaluate((threadId) => {
      window.__JASMINE_MESSAGE_LOAD_DELAYS__ = { [threadId]: [2_200] };
    }, ids.alpha);
    await page.locator(".rich-composer-editor").fill(staleFailurePrompt);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".user-message-wrap", { hasText: staleFailurePrompt })).toBeVisible();
    await expect.poll(() => page.evaluate((threadId) => (
      window.__JASMINE_MESSAGE_LOAD_DELAYS__?.[threadId]?.length ?? -1
    ), ids.alpha)).toBe(0);
    await page.getByRole("button", { name: new RegExp(betaPrompt, "i") }).first().click();
    await expect(page.locator(".message-stack")).toContainText(betaPrompt);
    await page.waitForTimeout(2_500);
    await expect(page.locator(".message-stack")).toContainText(betaPrompt);
    await expect(page.locator(".message-stack")).not.toContainText(alphaPrompt);
    await expect(page.locator(".message-stack")).not.toContainText(staleFailurePrompt);
    await expect(page.locator(".error-strip")).toBeHidden();
  });

  test("provider failure reconciliation preserves an explicitly loaded historical prefix and reading position", async () => {
    const { page, userDataDir } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Large provider failure boundary" }));
    seedLargeThreadMessages(userDataDir, thread.id, 321);
    updateSeededMessageContent(userDataDir, "large-0100", "working failure early loaded retry boundary");
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /Large provider failure boundary/ }).click();
    await expect(page.locator(".message-stack [data-message-id]")).toHaveCount(160);
    while (await page.locator(".message-stack [data-message-id]").count() < 321) {
      const before = await page.locator(".message-stack [data-message-id]").count();
      await page.locator(".load-older-messages").click();
      await expect.poll(() => page.locator(".message-stack [data-message-id]").count()).toBeGreaterThan(before);
    }

    // Retrying an early assistant truncates the optimistic renderer state to
    // its user anchor. That anchor is outside a fixed latest-160 page, while the
    // provider fails before main deletes anything; reconciliation must restore
    // all 321 authoritative DB rows, including the omitted middle segment.
    await page.locator("[data-message-id='large-0101']").getByRole("button", { name: "Regenerate this response" }).click();
    const scroll = page.locator(".message-scroll");
    await scroll.evaluate((node) => { node.scrollTop = 2_400; });
    await scroll.dispatchEvent("wheel", { deltaY: -80 });
    const before = await page.evaluate(() => {
      const first = document.querySelector("[data-message-id='large-0000']");
      const scrollNode = document.querySelector(".message-scroll");
      if (!first || !(scrollNode instanceof HTMLElement)) throw new Error("Large failure fixtures are missing.");
      (window as Window & { __JASMINE_LARGE_FAILURE_FIRST__?: Element }).__JASMINE_LARGE_FAILURE_FIRST__ = first;
      return { scrollTop: scrollNode.scrollTop };
    });

    await expect(page.locator(".assistant-block.error-message")).toContainText("Mock Working failure.");
    await expect(page.locator(".message-stack [data-message-id]")).toHaveCount(322);
    await expect(page.locator(".message-stack [data-message-id]").first()).toHaveAttribute("data-message-id", "large-0000");

    const after = await page.evaluate(() => {
      const first = document.querySelector("[data-message-id='large-0000']");
      const scrollNode = document.querySelector(".message-scroll");
      const remembered = (window as Window & { __JASMINE_LARGE_FAILURE_FIRST__?: Element }).__JASMINE_LARGE_FAILURE_FIRST__;
      if (!first || !(scrollNode instanceof HTMLElement)) throw new Error("Large failure result is missing.");
      return {
        sameFirst: remembered === first && first.isConnected,
        scrollTop: scrollNode.scrollTop
      };
    });
    expect(after.sameFirst).toBe(true);
    expect(before.scrollTop).toBeGreaterThan(0);
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
  });

  // "a promoted delayed initial load keeps an older identical prompt without
  // painting a third copy" moved to tests/renderer/chatMessageRuns.test.tsx.

  test("send, retry, edit, queue, and stop publish ordered persisted stream settlements", async () => {
    const { page } = harness;
    const result = await page.evaluate(async () => {
      const thread = await window.jasmine.createThread({ title: "Stream settlement protocol" });
      const events: Array<Parameters<Parameters<typeof window.jasmine.onChatStream>[0]>[0]> = [];
      const unsubscribe = window.jasmine.onChatStream((event) => events.push(event));
      const request = (requestId: string, content: string) => ({
        requestId,
        threadId: thread.id,
        content,
        attachments: [],
        messages: [],
        toolsEnabled: true
      });
      const waitForRunning = async (requestId: string) => {
        const deadline = Date.now() + 10_000;
        while (!events.some((event) => event.requestId === requestId && event.status === "running" && (event.liveMessages || event.delta))) {
          if (Date.now() > deadline) throw new Error(`No running stream event for ${requestId}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };

      try {
        const sendId = `settlement-send-${crypto.randomUUID()}`;
        const sent = await window.jasmine.sendChatMessage(request(sendId, "settlement initial request"));

        const retryId = `settlement-retry-${crypto.randomUUID()}`;
        const retried = await window.jasmine.retryChatMessage({
          requestId: retryId,
          threadId: thread.id,
          messageId: sent.assistantMessage.id,
          toolsEnabled: true
        });

        const editId = `settlement-edit-${crypto.randomUUID()}`;
        const edited = await window.jasmine.editChatMessage({
          requestId: editId,
          threadId: thread.id,
          messageId: sent.userMessage.id,
          content: "settlement edited request",
          attachments: [],
          toolsEnabled: true
        });

        const queueId = `settlement-queue-${crypto.randomUUID()}`;
        const queuedRun = window.jasmine.sendChatMessage(request(queueId, "slow response settlement queued run"));
        await window.jasmine.queueChatMessage({
          requestId: queueId,
          threadId: thread.id,
          mode: "followUp",
          content: "settlement queued follow up",
          attachments: []
        });
        const queued = await queuedRun;

        const stopId = `settlement-stop-${crypto.randomUUID()}`;
        const stoppedRun = window.jasmine.sendChatMessage(request(stopId, "slow timeline settlement stop"));
        await waitForRunning(stopId);
        if (!await window.jasmine.cancelChatMessage(stopId)) throw new Error("Stop request was not accepted.");
        const stopped = await stoppedRun;

        // Give any asynchronous title callback or stray runtime callback a chance
        // to publish; no running event may arrive after a settlement.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          requestIds: { sendId, retryId, editId, queueId, stopId },
          responseIds: {
            send: [sent.userMessage.id, sent.assistantMessage.id],
            retry: retried.assistantMessage.id,
            edit: [edited.userMessage.id, edited.assistantMessage.id],
            queue: queued.assistantMessage.id,
            stop: stopped.assistantMessage.id
          },
          events: events.map((event) => ({
            requestId: event.requestId,
            status: event.status,
            settlement: event.settlement ? {
              replaceAfterMessageId: event.settlement.replaceAfterMessageId ?? null,
              replaceFromMessageId: event.settlement.replaceFromMessageId ?? null,
              messages: event.settlement.messages.map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content,
                renderId: message.renderId ?? null
              }))
            } : null
          }))
        };
      } finally {
        unsubscribe();
      }
    });

    const settlementFor = (requestId: string) => result.events.find((event) => (
      event.requestId === requestId && event.settlement !== null
    ));
    const assertNoLateRunning = (requestId: string) => {
      const settlementIndex = result.events.findIndex((event) => event.requestId === requestId && event.settlement !== null);
      expect(settlementIndex).toBeGreaterThanOrEqual(0);
      expect(result.events.slice(settlementIndex + 1).some((event) => event.requestId === requestId && event.status === "running")).toBe(false);
    };

    const sent = settlementFor(result.requestIds.sendId);
    expect(sent?.status).toBe("done");
    expect(sent?.settlement?.replaceAfterMessageId).toBeNull();
    expect(sent?.settlement?.messages.map((message) => message.id)).toEqual(result.responseIds.send);
    expect(sent?.settlement?.messages.map((message) => message.renderId)).toEqual([
      `pending-${result.requestIds.sendId}-0`,
      `stream-${result.requestIds.sendId}-0`
    ]);

    const retried = settlementFor(result.requestIds.retryId);
    expect(retried?.status).toBe("done");
    expect(retried?.settlement?.replaceAfterMessageId).toBe(result.responseIds.send[0]);
    expect(retried?.settlement?.replaceFromMessageId).toBe(result.responseIds.send[1]);
    expect(retried?.settlement?.messages.map((message) => message.role)).toEqual(["assistant"]);
    expect(retried?.settlement?.messages.at(-1)?.id).toBe(result.responseIds.retry);
    expect(retried?.settlement?.messages.at(-1)?.renderId).toBe(`stream-${result.requestIds.retryId}-0`);

    const edited = settlementFor(result.requestIds.editId);
    expect(edited?.status).toBe("done");
    expect(edited?.settlement?.messages.map((message) => message.id)).toEqual(result.responseIds.edit);
    expect(edited?.settlement?.messages[0]?.renderId).toBeNull();
    expect(edited?.settlement?.messages.at(-1)?.renderId).toBe(`stream-${result.requestIds.editId}-0`);

    const queued = settlementFor(result.requestIds.queueId);
    expect(queued?.status).toBe("done");
    expect(queued?.settlement?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(queued?.settlement?.messages[0]?.renderId).toBe(`pending-${result.requestIds.queueId}-0`);
    expect(queued?.settlement?.messages.slice(1).map((message) => message.renderId)).toEqual([
      `stream-${result.requestIds.queueId}-0`,
      `stream-${result.requestIds.queueId}-1`,
      `stream-${result.requestIds.queueId}-2`
    ]);
    expect(queued?.settlement?.messages.at(-1)?.id).toBe(result.responseIds.queue);

    const stopped = settlementFor(result.requestIds.stopId);
    expect(stopped?.status).toBe("aborted");
    expect(stopped?.settlement?.messages.at(-1)?.id).toBe(result.responseIds.stop);
    expect(stopped?.settlement?.messages.at(-1)?.renderId).toBe(`stream-${result.requestIds.stopId}-0`);

    for (const requestId of Object.values(result.requestIds)) assertNoLateRunning(requestId);
  });

  test("window destroyed mid-stream does not crash the main process", async () => {
    // Own instance with a wide stream throttle so a chunk reliably lands on the
    // trailing setTimeout path instead of the (promise-handled) direct flush.
    const crash = await launchJasmine("destroyed-mid-stream", undefined, {
      JASMINE_E2E_STREAM_THROTTLE_MS: "1500"
    });
    try {
      const { app, page } = crash;
      await startEmptyThread(page);

      // Capture main-process uncaught exceptions directly. This also replaces
      // Electron's default handler, which would otherwise block the process
      // behind a modal "A JavaScript error occurred in the main process" box.
      await app.evaluate(() => {
        const globals = globalThis as { __mainCrashes?: string[] };
        globals.__mainCrashes = [];
        process.on("uncaughtException", (error) => {
          globals.__mainCrashes?.push(String(error));
        });
      });

      // "slow timeline" streams chunks at a 1s cadence: chunk 1 flushes
      // immediately, chunk 2 (t=2s) lands inside the 1.5s throttle window and
      // schedules a trailing timer for t=2.5s.
      await page.locator(".rich-composer-editor").fill("slow timeline stream then quit");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.locator(".assistant-block.live-message").last()).toBeVisible();

      // Destroy the renderer before that timer fires. Without the
      // destroyed-WebContents guard the timer callback throws an uncaught
      // "Object has been destroyed" TypeError in the main process.
      await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
      });
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const crashes = await app.evaluate(() => (globalThis as { __mainCrashes?: string[] }).__mainCrashes ?? []);
      expect(crashes).toEqual([]);

      const closed = app.waitForEvent("close");
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
      await closed;
    } finally {
      await quitElectron(crash.app);
      await rm(crash.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("message jump rail stays out of queued message controls while a response is running", async () => {
    const { page, userDataDir } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Queue rail overlap" }));
    seedLargeThreadMessages(userDataDir, thread.id, 60);
    await page.reload();
    await page.waitForSelector(".app-shell");

    await page.getByRole("button", { name: /Queue rail overlap/ }).click();
    await expect(page.locator(".message-jump-rail")).toBeVisible();
    await page.locator(".rich-composer-editor").fill("slow response slow timeline queue rail base");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();

    await page.locator(".rich-composer-editor").fill("queued rail boundary request");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect(page.locator(".queue-item")).toHaveCount(1);
    await page.getByRole("button", { name: "Open user message navigation" }).click();
    await expect(page.locator(".message-jump-menu")).toHaveCSS("opacity", "1");

    const geometry = await page.evaluate(() => {
      const rail = document.querySelector(".message-jump-rail")?.getBoundingClientRect();
      const composer = document.querySelector(".composer")?.getBoundingClientRect();
      const deleteButton = document.querySelector("[aria-label='Delete queued message 1']")?.getBoundingClientRect();
      if (!rail || !composer || !deleteButton) throw new Error("Queue rail geometry missing.");
      const overlapsDelete = !(rail.right < deleteButton.left || rail.left > deleteButton.right || rail.bottom < deleteButton.top || rail.top > deleteButton.bottom);
      return {
        railBottom: rail.bottom,
        composerTop: composer.top,
        overlapsDelete
      };
    });
    expect(geometry.railBottom).toBeLessThanOrEqual(geometry.composerTop - 4);
    expect(geometry.overlapsDelete).toBe(false);
  });

  test("running composer queues editable follow-ups, deletes pending rows, steers after queueing, and ignores nearby non-control clicks", async () => {
    const { page, userDataDir } = harness;
    // This deliberately long title also guards the macOS failure where the E2E
    // data directory plus Pi's encoded cwd exceeded one component's byte limit.
    expect(Buffer.byteLength(path.basename(userDataDir), "utf8")).toBeLessThanOrEqual(E2E_USER_DATA_DIR_COMPONENT_MAX_BYTES);
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "slow response slow timeline queue base" }));
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /slow response slow timeline queue base/ }).click();
    await expect(page.locator(".thread-row.active", { hasText: "slow response slow timeline queue base" })).toHaveCount(1);

    await page.locator(".rich-composer-editor").fill("slow response slow timeline queue base");
    await page.getByRole("button", { name: "Send" }).click();
    // Send and Stop are the same button under two names, so asserting the user
    // bubble first keeps "the send never registered" distinguishable from "the
    // reply already finished".
    await expect(page.locator(".user-bubble")).toHaveCount(1);
    // Stop appears optimistically with renderer run state. Wait for a real
    // assistant stream update as well, proving main has entered the generation
    // whose queue controls this spec exercises. The adjacent queue-rail test
    // retains coverage for queueing before the first assistant chunk.
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".assistant-block.live-message").last()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();

    await page.locator(".rich-composer-editor").fill("queued follow up request");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect(page.locator(".queue-item")).toHaveCount(1);
    await expect(page.locator(".queue-item").first()).toContainText("queued follow up request");
    await expectComposerEditorText(page.locator(".rich-composer-editor"), "");

    await page.getByRole("button", { name: "Edit queued message 1" }).click();
    await page.getByRole("textbox", { name: "Edit queued message 1" }).fill("edited queued follow up request");
    await page.locator(".queue-item").first().getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".queue-item").first()).toContainText("edited queued follow up request");

    await page.locator(".rich-composer-editor").fill("queued delete request");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect(page.locator(".queue-item")).toHaveCount(2);
    await page.getByRole("button", { name: "Delete queued message 2" }).click();
    await expect(page.locator(".queue-item")).toHaveCount(1);
    await expect(page.locator(".queue-row")).not.toContainText("queued delete request");

    const spacerBox = await page.locator(".composer-spacer").boundingBox();
    expect(spacerBox).not.toBeNull();
    await page.mouse.click((spacerBox?.x ?? 0) + Math.min(6, (spacerBox?.width ?? 12) / 2), (spacerBox?.y ?? 0) + (spacerBox?.height ?? 24) / 2);
    await expect(page.locator(".queue-mode-menu")).toHaveCount(0);
    await expect(page.locator(".queue-item")).toHaveCount(1);

    await page.locator(".rich-composer-editor").fill("steer correction request slow timeline");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect(page.locator(".queue-item")).toHaveCount(2);
    await page.locator(".queue-item").nth(1).getByRole("button", { name: "Steer", exact: true }).click();
    await expect(page.locator(".queue-item").nth(1)).toContainText("Steer");
    const e2eArtifactDir = path.join(rootDir, "test-results", "ui-harness", "e2e");
    await mkdir(e2eArtifactDir, { recursive: true });
    await page.screenshot({ path: path.join(e2eArtifactDir, "queue-message-row.png") });

    await expect(page.locator(".user-bubble", { hasText: "steer correction request slow timeline" })).toBeVisible({ timeout: 20000 });
    // Zero-latency steer: the steered user turn renders at the delivery instant in a live
    // streaming state, before the steered reply emits any token (not after the run finishes).
    await expect(page.locator(".assistant-block.live-message").last()).toBeVisible();
    await expect(page.locator(".message-stack")).not.toContainText("Steered response complete: steer correction request slow timeline");
    await expect(page.locator(".assistant-block.live-message", { hasText: "Steered response" }).last()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".queue-item")).toHaveCount(1);
    await expect(page.locator(".assistant-block").last()).toContainText("Queued follow-up complete: edited queued follow up request", { timeout: 30000 });
    await expect(page.locator(".queue-item")).toHaveCount(0);
    await expect(page.locator(".assistant-block.live-message")).toHaveCount(0, { timeout: 30000 });

    await expect.poll(async () => page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("slow response slow timeline queue base"));
      return thread ? (await window.jasmine.listMessages(thread.id)).length : 0;
    }), { timeout: 10000 }).toBe(6);

    const persisted = await page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("slow response slow timeline queue base"));
      if (!thread) throw new Error("Queued thread missing.");
      return {
        threadId: thread.id,
        messages: (await window.jasmine.listMessages(thread.id)).map((message) => ({
          role: message.role,
          content: message.content
        })),
        assistantRuns: (await window.jasmine.listMessages(thread.id))
          .filter((message) => message.role === "assistant")
          .map((message) => ({ runId: message.runId ?? null, elapsedMs: message.elapsedMs ?? null }))
      };
    });
    expect(persisted.messages).toEqual([
      { role: "user", content: "slow response slow timeline queue base" },
      { role: "assistant", content: "Slow response complete." },
      { role: "user", content: "steer correction request slow timeline" },
      { role: "assistant", content: "Steered response complete: steer correction request slow timeline" },
      { role: "user", content: "edited queued follow up request" },
      { role: "assistant", content: "Queued follow-up complete: edited queued follow up request" }
    ]);
    expect(new Set(persisted.assistantRuns.map((message) => message.runId)).size).toBe(1);
    expect(persisted.assistantRuns.every((message) => Boolean(message.runId))).toBe(true);
    expect(persisted.assistantRuns.slice(0, -1).every((message) => message.elapsedMs === null)).toBe(true);
    expect(Number(persisted.assistantRuns.at(-1)?.elapsedMs)).toBeGreaterThan(0);
    const piSession = await readThreadPiSession(userDataDir, persisted.threadId);
    expect(piSession.sessionId).toBe(persisted.threadId);
    expect(piSession.formatVersion).toBeGreaterThan(0);
    expect(piSession.messageEntryIds).toHaveLength(6);
    expect(piSession.messageEntryIds.every(Boolean)).toBe(true);
    const piSessionText = JSON.stringify(piSession.entries);
    expect(piSessionText).toContain("steer correction request slow timeline");
    expect(piSessionText).toContain("edited queued follow up request");
    expect(piSessionText).not.toContain("queued delete request");
  });

  // "A to B to A message loads cannot overwrite a live settlement" moved to
  // tests/renderer/chatMessageReconciliation.test.tsx. It provoked the ordering
  // with three ~5s __JASMINE_MESSAGE_LOAD_DELAYS__ waits plus a 5.5s settle, for
  // 12.3s a run; the renderer version holds and releases the in-flight replies
  // explicitly, so the ordering under test is the ordering that runs.

  test("a delayed large initial page prepends without displacing an auto-followed live tail", async () => {
    const { page, userDataDir } = harness;
    await page.setViewportSize({ width: 1024, height: 668 });
    const historyTitle = "Delayed large prepend viewport boundary";
    const livePrompt = "return long answer smooth stream delayed large prepend viewport";

    await startEmptyThread(page);
    const thread = await page.evaluate((title) => window.jasmine.createThread({ title }), historyTitle);
    seedLargeThreadMessages(userDataDir, thread.id, 160);
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.evaluate((threadId) => {
      window.__JASMINE_MESSAGE_LOAD_DELAYS__ = { [threadId]: [2_500] };
    }, thread.id);
    await page.getByRole("button", { name: historyTitle }).first().click();
    await expect.poll(() => page.evaluate((threadId) => (
      window.__JASMINE_MESSAGE_LOAD_DELAYS__?.[threadId]?.length ?? -1
    ), thread.id)).toBe(0);

    await page.locator(".rich-composer-editor").fill(livePrompt);
    await page.getByRole("button", { name: "Send" }).click();
    const liveAssistant = page.locator(".assistant-block.live-message").last();
    await expect(liveAssistant).toBeVisible();
    await liveAssistant.evaluate((liveNode) => {
      type ViewportSample = {
        historyLoaded: boolean;
        scrollTop: number;
        anchorViewportTop: number;
        tailBottomOffset: number;
        tailVisible: boolean;
        naturalTailViewportTop: number;
      };
      type PrependMonitor = {
        frames: ViewportSample[];
        postMutation: { before: ViewportSample; after: ViewportSample } | null;
        prependSamplePending: boolean;
        disconnected: boolean;
        replaced: boolean;
        observer: MutationObserver;
        frameId: number;
      };
      const scope = window as Window & { __JASMINE_DELAYED_PREPEND_MONITOR__?: PrependMonitor };
      const scroll = document.querySelector<HTMLElement>(".message-scroll");
      const stack = document.querySelector<HTMLElement>(".message-stack");
      const userNode = liveNode.previousElementSibling;
      if (!scroll || !stack || !(liveNode instanceof HTMLElement)) {
        throw new Error("Delayed-prepend viewport fixture is missing.");
      }
      if (!(userNode instanceof HTMLElement)) throw new Error("Delayed-prepend user anchor is missing.");
      const liveMessageId = liveNode.dataset.messageId;
      const userMessageId = userNode.dataset.messageId;
      if (!liveMessageId || !userMessageId) throw new Error("Delayed-prepend message identity is missing.");
      const measure = (): ViewportSample => {
        const currentLiveNode = document.querySelector<HTMLElement>(`[data-message-id="${liveMessageId}"]`);
        const currentUserNode = document.querySelector<HTMLElement>(`[data-message-id="${userMessageId}"]`);
        if (!currentLiveNode || !currentUserNode) throw new Error("Delayed-prepend message identity disconnected.");
        const scrollRect = scroll.getBoundingClientRect();
        const tailRect = currentLiveNode.getBoundingClientRect();
        const anchorRect = currentUserNode.getBoundingClientRect();
        const actions = currentLiveNode.querySelector<HTMLElement>(":scope > .message-actions");
        if (!actions) throw new Error("Delayed-prepend natural tail is missing.");
        const actionsRect = actions.getBoundingClientRect();
        const monitor = scope.__JASMINE_DELAYED_PREPEND_MONITOR__;
        if (monitor && (currentLiveNode !== liveNode || currentUserNode !== userNode)) monitor.replaced = true;
        return {
          historyLoaded: Boolean(document.querySelector("[data-message-id='large-0000']")),
          scrollTop: scroll.scrollTop,
          anchorViewportTop: anchorRect.top - scrollRect.top,
          tailBottomOffset: Math.max(0, tailRect.bottom - scrollRect.bottom),
          tailVisible: tailRect.bottom > scrollRect.top && tailRect.top < scrollRect.bottom,
          naturalTailViewportTop: actionsRect.top - scrollRect.top
        };
      };
      const monitor: PrependMonitor = {
        frames: [],
        postMutation: null,
        prependSamplePending: false,
        disconnected: false,
        replaced: false,
        observer: new MutationObserver(() => undefined),
        frameId: 0
      };
      const observer = new MutationObserver(() => {
        if (monitor.postMutation || monitor.prependSamplePending
          || !document.querySelector("[data-message-id='large-0000']")) return;
        monitor.prependSamplePending = true;
        // The hook's message layout effect has already compensated the anchor
        // in this commit. Sample in the following microtask so this assertion
        // observes the final pre-paint state for the prepend boundary.
        queueMicrotask(() => {
          const before = [...monitor.frames].reverse().find((sample) => !sample.historyLoaded);
          if (before && liveNode.isConnected) monitor.postMutation = { before, after: measure() };
          monitor.prependSamplePending = false;
        });
      });
      monitor.observer = observer;
      observer.observe(stack, { childList: true });
      const sampleFrame = () => {
        if (!liveNode.isConnected) {
          monitor.disconnected = true;
          return;
        }
        if (!liveNode.classList.contains("live-message")) return;
        // Reading layout in a microtask after the animation callback keeps the
        // sample on the same paint boundary while including pre-paint observers.
        queueMicrotask(() => {
          if (liveNode.isConnected && liveNode.classList.contains("live-message")) {
            monitor.frames.push(measure());
          }
        });
        monitor.frameId = requestAnimationFrame(sampleFrame);
      };
      monitor.frameId = requestAnimationFrame(sampleFrame);
      scope.__JASMINE_DELAYED_PREPEND_MONITOR__ = monitor;
    });

    await expect(page.locator("[data-message-id^='large-']")).toHaveCount(160, { timeout: 5_000 });
    await expect.poll(() => page.evaluate(() => Boolean((window as Window & {
      __JASMINE_DELAYED_PREPEND_MONITOR__?: { postMutation: unknown };
    }).__JASMINE_DELAYED_PREPEND_MONITOR__?.postMutation))).toBe(true);
    await waitForStableAssistant(page, "Long answer paragraph 42", 12_000);

    const continuity = await page.evaluate(() => {
      type ViewportSample = {
        historyLoaded: boolean;
        scrollTop: number;
        anchorViewportTop: number;
        tailBottomOffset: number;
        tailVisible: boolean;
        naturalTailViewportTop: number;
      };
      const monitor = (window as Window & {
        __JASMINE_DELAYED_PREPEND_MONITOR__?: {
          frames: ViewportSample[];
          postMutation: { before: ViewportSample; after: ViewportSample } | null;
          disconnected: boolean;
          replaced: boolean;
          observer: MutationObserver;
          frameId: number;
        };
      }).__JASMINE_DELAYED_PREPEND_MONITOR__;
      if (!monitor?.postMutation) throw new Error("Delayed prepend was not sampled.");
      monitor.observer.disconnect();
      cancelAnimationFrame(monitor.frameId);

      let prependFrameScrollAdvance = 0;
      let prependFrameTailDrift = 0;
      let prependTransitions = 0;
      for (let index = 1; index < monitor.frames.length; index += 1) {
        const previous = monitor.frames[index - 1];
        const current = monitor.frames[index];
        const scrollAdvance = current.scrollTop - previous.scrollTop;
        if (previous.historyLoaded !== current.historyLoaded) {
          prependTransitions += 1;
          prependFrameScrollAdvance = Math.max(prependFrameScrollAdvance, scrollAdvance);
          prependFrameTailDrift = Math.max(
            prependFrameTailDrift,
            Math.abs(current.anchorViewportTop - previous.anchorViewportTop)
          );
        }
      }
      return {
        framesBeforePrepend: monitor.frames.filter((sample) => !sample.historyLoaded).length,
        framesAfterPrepend: monitor.frames.filter((sample) => sample.historyLoaded).length,
        prependTransitions,
        prependFrameScrollAdvance,
        prependFrameTailDrift,
        mutationTailDrift: Math.abs(
          monitor.postMutation.after.anchorViewportTop - monitor.postMutation.before.anchorViewportTop
        ),
        mutationTailVisible: monitor.postMutation.after.tailVisible,
        mutationNaturalTailDrift: Math.abs(
          monitor.postMutation.after.naturalTailViewportTop - monitor.postMutation.before.naturalTailViewportTop
        ),
        maxTailBottomOffset: Math.max(0, ...monitor.frames.map((sample) => sample.tailBottomOffset)),
        allTailFramesVisible: monitor.frames.every((sample) => sample.tailVisible),
        disconnected: monitor.disconnected,
        replaced: monitor.replaced
      };
    });

    expect(continuity.framesBeforePrepend).toBeGreaterThan(0);
    expect(continuity.framesAfterPrepend).toBeGreaterThan(0);
    expect(continuity.prependTransitions).toBe(1);
    expect(continuity.prependFrameScrollAdvance).toBeGreaterThan(1_000);
    expect(continuity.mutationTailVisible).toBe(true);
    expect(continuity.allTailFramesVisible).toBe(true);
    // The comparison spans one painted frame, so it may include one ordinary
    // follower step. Without prepend compensation this drift is ~20,000px;
    // with compensation it remains within the same 16px visual budget.
    expect(continuity.mutationTailDrift).toBeLessThanOrEqual(17);
    expect(continuity.mutationNaturalTailDrift).toBeLessThanOrEqual(17);
    expect(continuity.prependFrameTailDrift).toBeLessThanOrEqual(17);
    expect(continuity.maxTailBottomOffset).toBeLessThanOrEqual(17);
    expect(continuity.disconnected).toBe(false);
    expect(continuity.replaced).toBe(false);
  });

  // "a rapid second run invalidates the initial page promoted to the first run"
  // moved to tests/renderer/chatMessageRuns.test.tsx. It staged the race with a
  // 2.2s __JASMINE_MESSAGE_LOAD_DELAYS__ wait and a 12s settle window; the
  // renderer version holds the opening page across both runs instead. Verified
  // against three injected defects in the promoted-load boundary.

  test("paged retry removes a stale page-first assistant when its anchor is outside the delayed page", async () => {
    const { page, userDataDir } = harness;
    const threads = await page.evaluate(async () => ({
      alpha: await window.jasmine.createThread({ title: "Paged retry alpha" }),
      beta: await window.jasmine.createThread({ title: "Paged retry beta" })
    }));
    // The latest page contains rows 1..160: its first row is the assistant being
    // retried, while the retained user anchor at row 0 is just outside the page.
    seedLargeThreadMessages(userDataDir, threads.alpha.id, 161);
    updateSeededMessageContent(
      userDataDir,
      "large-0000",
      "slow response slow timeline paged retry boundary"
    );
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /Paged retry alpha/ }).click();
    const staleTarget = page.locator("[data-message-id='large-0001']");
    await expect(staleTarget).toBeVisible();
    await expect(page.locator(".message-stack [data-message-id]").first()).toHaveAttribute("data-message-id", "large-0001");

    await page.evaluate((threadId) => {
      window.__JASMINE_MESSAGE_LOAD_DELAYS__ = { [threadId]: [5_000] };
    }, threads.alpha.id);
    await staleTarget.getByRole("button", { name: "Regenerate this response" }).click();
    await expect(page.locator(".assistant-block.live-message").last()).toBeVisible();

    // The A page is read before the slow retry commits, then delivered after its
    // settlement. Its missing anchor must fall back to replaceFromMessageId and
    // remove the stable stale target instead of rendering both replies.
    await page.getByRole("button", { name: /Paged retry beta/ }).click();
    await expect(page.locator(".empty-state")).toBeVisible();
    await page.getByRole("button", { name: /Paged retry alpha/ }).click();
    await waitForStableAssistant(page, "Slow response complete.", 12_000);
    await page.waitForTimeout(5_500);

    await expect(page.locator("[data-message-id='large-0001']")).toHaveCount(0);
    await expect(page.locator(".assistant-block:not(.live-message)")).toHaveCount(1);
    await expect(page.locator(".assistant-block").last()).toContainText("Slow response complete.");
    await expect(page.locator(".message-stack")).not.toContainText("large import message 2");
    await expect(page.locator(".error-strip")).toBeHidden();
  });

  test("running response can be stopped without canceling background thread work", async () => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("slow timeline stoppable tool stop regression");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
    const activeAssistant = page.locator(".assistant-block").last();
    // Stop only after the first stream chunk visibly rendered thinking + tool
    // work; a fixed sleep raced the first paint and could stop an empty run.
    await expect(activeAssistant.locator(".message-timeline")).toContainText("Thinking");
    const activeBashTool = activeAssistant.locator(".tool-run-item[data-tool-name='bash']");
    await expect(activeBashTool).toBeVisible();
    await expect(activeBashTool).toContainText("find / -name node");
    await expect(activeBashTool).toHaveClass(/running/);
    await page.getByRole("button", { name: "Stop response" }).click();
    await expect(activeAssistant.locator(".run-header-toggle")).toContainText("Stopped after");
    // An interrupted run is never folded away: the reader has to see where it
    // got to, so the header is a label rather than a disclosure.
    await expect(activeAssistant.locator(".run-header-toggle")).not.toHaveAttribute("aria-expanded", "false");
    await expect(activeAssistant.locator(".message-timeline")).toContainText("Stopped");
    await expect(activeAssistant.locator(".message-timeline")).toContainText("The response was stopped by the user.");
    await expect(activeAssistant.locator(".message-timeline")).toContainText("Thinking");
    await expect(activeBashTool).toContainText("find / -name node");
    await expect(activeBashTool).toHaveClass(/stopped/);
    await expect(activeBashTool).not.toHaveClass(/running/);
    await expect(activeBashTool.locator(".timeline-row-state-text")).toHaveText("Stopped");
    await expect(page.locator(".error-strip")).toBeHidden();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

    await quitElectron(harness.app);
    harness = await launchJasmine("stopped-timeline-reopen", userDataDir);
    const reopenedPage = harness.page;
    const stoppedThreadRow = reopenedPage.locator(".thread-row", { hasText: "slow timeline stoppable" }).first();
    await expect(stoppedThreadRow).toBeVisible();
    await stoppedThreadRow.click();
    const reopenedAssistant = reopenedPage.locator(".assistant-block").last();
    await expect(reopenedAssistant.locator(".run-header-toggle")).toContainText("Stopped after");
    await expect(reopenedAssistant.locator(".message-timeline")).toContainText("Thinking");
    const reopenedBashTool = reopenedAssistant.locator(".tool-run-item[data-tool-name='bash']");
    await expect(reopenedBashTool).toContainText("find / -name node");
    await expect(reopenedAssistant.locator(".message-timeline")).toContainText("Stopped");
    await expect(reopenedBashTool).toHaveClass(/stopped/);
    await expect(reopenedBashTool).not.toHaveClass(/running/);

    await reopenedPage.locator(".rich-composer-editor").fill("continue after stopped tool run");
    await reopenedPage.getByRole("button", { name: "Send" }).click();
    await expect(reopenedPage.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(reopenedPage.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(reopenedPage.locator(".error-strip")).toBeHidden();
    const stoppedThreadId = await reopenedPage.evaluate(async () => (await window.jasmine.listThreads()).find((thread) => thread.title.includes("slow timeline stoppable"))?.id);
    expect(stoppedThreadId).toBeTruthy();
    const stoppedPiSession = await readThreadPiSession(userDataDir, stoppedThreadId!);
    expect(stoppedPiSession.messageEntryIds).toHaveLength(4);
    expect(stoppedPiSession.messageEntryIds.every(Boolean)).toBe(true);
    expect(JSON.stringify(stoppedPiSession.entries)).toContain('"stopReason":"aborted"');

    const pageAfterReopen = harness.page;
    await pageAfterReopen.getByRole("button", { name: "New chat" }).first().click();
    await expect(pageAfterReopen.locator(".empty-state")).toBeVisible();
    await pageAfterReopen.locator(".rich-composer-editor").fill("slow response background keepalive");
    await pageAfterReopen.getByRole("button", { name: "Send" }).click();
    await expect(pageAfterReopen.getByRole("button", { name: "Stop response" })).toBeVisible();
    await pageAfterReopen.getByRole("button", { name: "New chat" }).first().click();
    await expect(pageAfterReopen.locator(".empty-state")).toBeVisible();
    const backgroundRow = pageAfterReopen.locator(".thread-row", { hasText: "slow response background keepali" }).first();
    await expect(backgroundRow).toBeVisible();
    await backgroundRow.click();
    await expect(pageAfterReopen.locator(".assistant-block").last()).toContainText("Slow response complete.");
  });

  test("provider traces stay auditable without exposing trace chrome or Jasmine-owned web search", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("traceable provider call");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");

    const traceMeta = await page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("traceable provider call"));
      if (!thread) throw new Error("Trace test thread missing.");
      const assistant = (await window.jasmine.listMessages(thread.id)).find((message) => message.role === "assistant");
      if (!assistant) throw new Error("Trace test assistant message missing.");
      const runs = await window.jasmine.listTracesForMessage(assistant.id);
      const detail = await window.jasmine.getTrace(runs[0].id);
      return {
        assistantId: assistant.id,
        runCount: runs.length,
        detailMessageId: detail.messageId,
        detailModelId: detail.modelId
      };
    });
    expect(traceMeta.runCount).toBe(1);
    expect(traceMeta.detailMessageId).toBe(traceMeta.assistantId);
    expect(traceMeta.detailModelId).toBe("deepseek-v4-flash");

    await expect(page.getByRole("button", { name: "Open trace" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Trace panel" })).toHaveCount(0);
    await expect(page.locator(".trace-panel")).toBeHidden();

    await startEmptyThread(page);

    // Web access belongs to the pi-web-access package now, so a turn must never
    // produce a trace the app owns.
    await page.locator(".rich-composer-editor").fill("current jasmine web access check");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Mock reply from Jasmine.");
    await expect(page.locator(".error-strip")).toBeHidden();

    const traceTitles = await page.evaluate(async () => {
      const thread = (await window.jasmine.listThreads()).find((item) => item.title.includes("current jasmine web access"));
      if (!thread) throw new Error("Web access thread missing.");
      return (await window.jasmine.listTracesForThread(thread.id)).map((run) => run.title);
    });
    expect(traceTitles.some((title) => title === "Web search")).toBe(false);
    expect(traceTitles.some((title) => title.includes("chat completion"))).toBe(true);
  });

  test("regenerate replaces the selected assistant turn and truncates later messages", async () => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("first branch");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "First branch reply.");

    await page.locator(".rich-composer-editor").fill("second branch slow timeline");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".message-actions:visible")).toHaveCount(0);
    await waitForStableAssistant(page, "Second branch reply.");
    await expect(page.locator(".user-bubble")).toHaveCount(2);
    await expect(page.locator(".assistant-block")).toHaveCount(2);

    await page.locator(".assistant-block").first().getByRole("button", { name: "Regenerate this response" }).click();

    await expect(page.locator(".user-bubble")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(".assistant-block:not(.live-message)")).toHaveCount(1, { timeout: 10_000 });
    await waitForStableAssistant(page, "First branch reply.");
    await expect(page.locator(".message-stack")).not.toContainText("second branch");
    await expect(page.locator(".message-stack")).not.toContainText("Second branch reply.");
    const threadId = await page.evaluate(async () => (await window.jasmine.listThreads()).find((thread) => thread.title.includes("first branch"))?.id);
    expect(threadId).toBeTruthy();
    const piSession = await readThreadPiSession(userDataDir, threadId!);
    expect(piSession.messageEntryIds).toHaveLength(2);
    expect(piSession.messageEntryIds.every(Boolean)).toBe(true);
    expect(JSON.stringify(piSession.entries)).toContain("second branch slow timeline");
  });

  test("editing a user message resends that branch and clears later turns", async () => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);

    await page.locator(".rich-composer-editor").fill("first branch");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "First branch reply.");

    await page.locator(".rich-composer-editor").fill("second branch");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForStableAssistant(page, "Second branch reply.");

    await page.locator(".user-message-wrap").first().evaluate((node) => {
      (window as typeof window & { __JASMINE_EDIT_USER_NODE__?: Element }).__JASMINE_EDIT_USER_NODE__ = node;
    });

    await page.locator(".user-message-wrap").first().hover();
    await page.locator(".user-message-wrap").first().getByRole("button", { name: "Edit message" }).click();
    await expect(page.locator(".edit-banner")).toContainText("Editing message");
    await expectComposerDraft(page, "first branch");

    await page.locator(".rich-composer-editor").fill("first branch edited");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.locator(".user-bubble")).toHaveCount(1);
    await expect(page.locator(".assistant-block")).toHaveCount(1);
    await expect(page.locator(".user-bubble").first()).toContainText("first branch edited");
    await waitForStableAssistant(page, "First branch reply.");
    expect(await page.evaluate(() => (
      (window as typeof window & { __JASMINE_EDIT_USER_NODE__?: Element }).__JASMINE_EDIT_USER_NODE__
      === document.querySelector(".user-message-wrap")
    ))).toBe(true);
    await expect(page.locator(".message-stack")).not.toContainText("second branch");
    await expect(page.locator(".message-stack")).not.toContainText("Second branch reply.");
    const threadId = await page.evaluate(async () => (await window.jasmine.listThreads()).find((thread) => thread.title.includes("first branch"))?.id);
    expect(threadId).toBeTruthy();
    const piSession = await readThreadPiSession(userDataDir, threadId!);
    expect(piSession.messageEntryIds).toHaveLength(2);
    expect(piSession.messageEntryIds.every(Boolean)).toBe(true);
    const piSessionText = JSON.stringify(piSession.entries);
    expect(piSessionText).toContain("first branch edited");
    expect(piSessionText).toContain("second branch");
  });

  test("missing provider key offers settings recovery and retry avoids duplicate user turns", async () => {
    const { page } = harness;
    await startEmptyThread(page);

    await page.evaluate(async () => {
      const provider = (await window.jasmine.listProviders())[0];
      await window.jasmine.updateProvider({
        id: provider.id,
        apiKeyRef: "env:JASMINE_E2E_MISSING_KEY"
      });
    });
    await page.reload();

    await page.locator(".rich-composer-editor").fill("Trigger missing provider");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".error-strip")).toContainText("not set");
    await page.getByRole("button", { name: "Configure provider" }).click();
    await expect(page.locator(".settings-panel")).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();

    const userCountBeforeRetry = await page.locator(".user-bubble").count();
    await page.evaluate(async () => {
      const provider = (await window.jasmine.listProviders())[0];
      await window.jasmine.updateProvider({
        id: provider.id,
        apiKeyRef: "env:DEEPSEEK_API_KEY"
      });
    });
    await page.getByRole("button", { name: "Regenerate this response" }).last().click();

    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect.poll(() => page.locator(".user-bubble").count()).toBe(userCountBeforeRetry);
  });
});
