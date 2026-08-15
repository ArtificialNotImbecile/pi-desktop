import { expect, test, type Page } from "@playwright/test";
import { rm } from "node:fs/promises";
import {
  launchJasmine,
  messageJumpMarkAlignment,
  quitElectron,
  seedLargeThreadMessages,
  waitForStableAssistant,
  type HarnessApp
} from "./helpers";

type JumpRailMetrics = {
  resizeObserversCreated: number;
  resizeObserversDisconnected: number;
  observedClasses: string[];
  messageTargetQueries: number;
  messageTargetRectReads: number;
};

test.describe("Jasmine message jump rail", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("keeps observers and message targets stable across assistant stream ticks", async () => {
    const { page } = harness;
    await installJumpRailMetrics(page);

    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Jump rail stream stability" }));
    seedLargeThreadMessages(harness.userDataDir, thread.id, 6);
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: "Jump rail stream stability" }).first().click();
    await expect(page.locator("[data-message-id]")).toHaveCount(6);
    await expect(page.locator(".message-jump-rail")).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
        .__JASMINE_JUMP_RAIL_METRICS__?.messageTargetQueries ?? 0
    ))).toBeGreaterThanOrEqual(3);
    await expect.poll(() => page.evaluate(() => (
      (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
        .__JASMINE_JUMP_RAIL_METRICS__?.messageTargetRectReads ?? 0
    ))).toBeGreaterThanOrEqual(3);
    const metricsBeforeSend = await page.evaluate(() => {
      const metrics = (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
        .__JASMINE_JUMP_RAIL_METRICS__;
      return {
        queries: metrics?.messageTargetQueries ?? 0,
        observers: metrics?.resizeObserversCreated ?? 0
      };
    });

    await page.locator(".rich-composer-editor").fill("slow response slow timeline jump rail stability");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block.live-message")).toBeVisible();
    // Wait for the optimistic user insertion to finish the jump rail's one
    // legitimate signature change before zeroing the stream-only window. Other
    // code also queries exact message ids, so a query-only wait can race the
    // passive effect under a busy full-suite worker and count this setup as an
    // assistant tick rebuild.
    await expect.poll(() => page.evaluate(({ minimumQueries, minimumObservers }) => {
      const metrics = (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
        .__JASMINE_JUMP_RAIL_METRICS__;
      return (metrics?.messageTargetQueries ?? 0) >= minimumQueries
        && (metrics?.resizeObserversCreated ?? 0) >= minimumObservers;
    }, {
      minimumQueries: metricsBeforeSend.queries + 4,
      minimumObservers: metricsBeforeSend.observers + 2
    })).toBe(true);

    const observedClasses = await page.evaluate(() => (
      (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
        .__JASMINE_JUMP_RAIL_METRICS__?.observedClasses ?? []
    ));
    expect(observedClasses.some((className) => className.split(/\s+/).includes("message-stack"))).toBe(true);

    await page.evaluate(() => {
      const metrics = (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
        .__JASMINE_JUMP_RAIL_METRICS__;
      if (!metrics) return;
      metrics.resizeObserversCreated = 0;
      metrics.resizeObserversDisconnected = 0;
      metrics.messageTargetQueries = 0;
      metrics.messageTargetRectReads = 0;
    });

    // Sample a later assistant-content chunk while the user-message signature
    // is unchanged. One growth is sufficient to prove this is a real stream
    // tick; requiring two can race the final chunk when several queued updates
    // flush together on a saturated full-suite worker.
    // The final persistence pass legitimately replaces the optimistic user id,
    // so it is intentionally outside this stream-tick assertion window.
    const liveOutput = page.locator(".assistant-block.live-message").last().getByLabel("Assistant output");
    const firstLength = (await liveOutput.textContent())?.length ?? 0;
    await expect.poll(async () => (await liveOutput.textContent())?.length ?? 0).toBeGreaterThan(firstLength);
    const streamingMetrics = await page.evaluate(() => (
      (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
        .__JASMINE_JUMP_RAIL_METRICS__
    ));
    expect(streamingMetrics).toMatchObject({
      resizeObserversCreated: 0,
      resizeObserversDisconnected: 0,
      messageTargetQueries: 0
    });
    // With four navigable user rows, this allows at most three full passes for
    // optimistic-row insertion and layout settling. It must not scale with the
    // 8 slow stream ticks.
    expect(streamingMetrics?.messageTargetRectReads ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(12);
    await waitForStableAssistant(page, "Slow response complete.", 12_000);

    // Let the final content ResizeObserver measurement settle, then exercise
    // many pure-scroll frames. The jump rail should select the current mark
    // from cached content coordinates without measuring every message again.
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const metrics = (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
        .__JASMINE_JUMP_RAIL_METRICS__;
      if (metrics) metrics.messageTargetRectReads = 0;
    });
    const scrollResult = await page.evaluate(async () => {
      const scroll = document.querySelector(".message-scroll");
      if (!(scroll instanceof HTMLElement)) return { events: 0, distance: 0 };
      let events = 0;
      const onScroll = () => { events += 1; };
      scroll.addEventListener("scroll", onScroll, { passive: true });
      const max = Math.max(scroll.scrollHeight - scroll.clientHeight, 1);
      let minSeen = scroll.scrollTop;
      let maxSeen = scroll.scrollTop;
      scroll.scrollTop = max;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      for (let index = 11; index >= 0; index -= 1) {
        scroll.scrollTop = (max * index) / 11;
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        minSeen = Math.min(minSeen, scroll.scrollTop);
        maxSeen = Math.max(maxSeen, scroll.scrollTop);
      }
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      scroll.removeEventListener("scroll", onScroll);
      return { events, distance: maxSeen - minSeen };
    });
    expect(scrollResult.events).toBeGreaterThanOrEqual(6);
    expect(scrollResult.distance).toBeGreaterThan(100);
    expect(await page.evaluate(() => (
      (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
        .__JASMINE_JUMP_RAIL_METRICS__?.messageTargetRectReads ?? -1
    ))).toBe(0);
  });

  test("remeasures cached positions once when an earlier thought disclosure moves later users", async () => {
    const { page } = harness;
    await installJumpRailMetrics(page);

    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Jump rail historical layout" }));
    seedLargeThreadMessages(harness.userDataDir, thread.id, 8, true);
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: "Jump rail historical layout" }).first().click();
    await expect(page.locator("[data-message-id]")).toHaveCount(8);
    await expect(page.locator(".message-jump-rail")).toBeVisible();

    const firstAssistant = page.locator("[data-message-id='large-0001']");
    const laterUser = page.locator("[data-message-id='large-0006']");
    // Seeded history settles with each successful run folded behind its header,
    // so open them first: this case measures how the rail remeasures when an
    // earlier thought disclosure moves later messages, which needs those rows
    // reachable.
    const runHeaders = page.locator(".run-header-toggle[aria-expanded='false']");
    await expect(runHeaders.first()).toBeVisible();
    for (let remaining = await runHeaders.count(); remaining > 0; remaining -= 1) {
      await runHeaders.first().click();
    }
    const thoughtToggle = firstAssistant.getByRole("button", { name: "Thinking" });
    await expect(thoughtToggle).toBeVisible();
    await expect(thoughtToggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => readMessageTargetRectReads(page)).toBeGreaterThanOrEqual(4);
    await page.waitForTimeout(100);

    const collapsedTop = await laterUser.evaluate((node) => (node as HTMLElement).offsetTop);
    await resetMessageTargetRectReads(page);
    await thoughtToggle.click();
    await expect(thoughtToggle).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => laterUser.evaluate((node) => (node as HTMLElement).offsetTop)).toBeGreaterThan(collapsedTop + 10);
    await expect.poll(() => readMessageTargetRectReads(page)).toBe(4);
    await page.waitForTimeout(100);
    expect(await readMessageTargetRectReads(page)).toBe(4);

    const expandedAlignment = await messageJumpMarkAlignment(page);
    expect(expandedAlignment.monotonic).toBe(true);
    expect(expandedAlignment.maxDelta).toBeLessThanOrEqual(1);

    // The rail marks whichever user message sits nearest the viewport centre.
    // Centre a message that has content below it: scrolling to the last one
    // clamps at the bottom, which leaves its neighbour nearest the centre and
    // makes the assertion depend on the fixture's exact height rather than on
    // the rail.
    await page.locator("[data-message-id='large-0004']").evaluate((node) => node.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(50);
    await expect(page.locator("[data-message-jump-id='large-0004']")).toHaveClass(/current/);

    await page.locator(".message-jump-trigger").click();
    await page.locator(".message-jump-menu button[title^='large import message 5']").click();
    await expect(page.locator("[data-message-id='large-0004']")).toHaveClass(/message-jump-target/);
    await expect.poll(() => page.locator("[data-message-id='large-0004']").evaluate((node) => {
      const scroll = document.querySelector(".message-scroll");
      if (!(scroll instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
      const target = node.getBoundingClientRect();
      const viewport = scroll.getBoundingClientRect();
      return Math.abs((target.top + target.height / 2) - (viewport.top + viewport.height / 2));
    })).toBeLessThanOrEqual(6);

    const expandedTop = await laterUser.evaluate((node) => (node as HTMLElement).offsetTop);
    await resetMessageTargetRectReads(page);
    await thoughtToggle.click();
    await expect(thoughtToggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => laterUser.evaluate((node) => (node as HTMLElement).offsetTop)).toBeLessThan(expandedTop - 10);
    await expect.poll(() => readMessageTargetRectReads(page)).toBe(4);
    await page.waitForTimeout(100);
    expect(await readMessageTargetRectReads(page)).toBe(4);

    const collapsedAlignment = await messageJumpMarkAlignment(page);
    expect(collapsedAlignment.monotonic).toBe(true);
    expect(collapsedAlignment.maxDelta).toBeLessThanOrEqual(1);
  });

  test("jump-menu navigation pauses live tail follow at the selected message", async () => {
    const { page } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Jump rail live reading intent" }));
    seedLargeThreadMessages(harness.userDataDir, thread.id, 8);
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: "Jump rail live reading intent" }).first().click();

    await page.locator(".rich-composer-editor").fill("slow response slow timeline jump rail reading intent");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block.live-message")).toBeVisible();
    await page.getByRole("button", { name: "Open user message navigation" }).click();
    await page.locator(".message-jump-menu button[title^='large import message 5']").click();

    const target = page.locator("[data-message-id='large-0004']");
    await expect(target).toHaveClass(/message-jump-target/);
    await expect.poll(() => target.evaluate((node) => {
      const scroll = document.querySelector(".message-scroll");
      if (!(scroll instanceof HTMLElement)) return Number.POSITIVE_INFINITY;
      const targetRect = node.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      return Math.abs((targetRect.top + targetRect.height / 2) - (scrollRect.top + scrollRect.height / 2));
    })).toBeLessThanOrEqual(6);
    const lockedTop = await page.locator(".message-scroll").evaluate((node) => node.scrollTop);
    await page.waitForTimeout(2_200);
    expect(Math.abs(await page.locator(".message-scroll").evaluate((node) => node.scrollTop) - lockedTop)).toBeLessThanOrEqual(4);
  });
});

async function installJumpRailMetrics(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics };
    const metrics: JumpRailMetrics = {
      resizeObserversCreated: 0,
      resizeObserversDisconnected: 0,
      observedClasses: [],
      messageTargetQueries: 0,
      messageTargetRectReads: 0
    };
    scope.__JASMINE_JUMP_RAIL_METRICS__ = metrics;

    const NativeResizeObserver = window.ResizeObserver;
    class CountingResizeObserver {
      private readonly observer: ResizeObserver;

      constructor(callback: ResizeObserverCallback) {
        metrics.resizeObserversCreated += 1;
        this.observer = new NativeResizeObserver(callback);
      }

      observe(target: Element, options?: ResizeObserverOptions): void {
        metrics.observedClasses.push(target instanceof HTMLElement ? target.className : target.nodeName);
        this.observer.observe(target, options);
      }

      unobserve(target: Element): void {
        this.observer.unobserve(target);
      }

      disconnect(): void {
        metrics.resizeObserversDisconnected += 1;
        this.observer.disconnect();
      }
    }
    window.ResizeObserver = CountingResizeObserver as typeof ResizeObserver;

    const documentQuerySelector = Document.prototype.querySelector;
    Document.prototype.querySelector = function querySelector(selectors: string) {
      if (selectors.startsWith("[data-message-id=\"")) metrics.messageTargetQueries += 1;
      return documentQuerySelector.call(this, selectors);
    } as typeof Document.prototype.querySelector;

    const elementQuerySelector = Element.prototype.querySelector;
    Element.prototype.querySelector = function querySelector(selectors: string) {
      if (selectors.startsWith("[data-message-id=\"")) metrics.messageTargetQueries += 1;
      return elementQuerySelector.call(this, selectors);
    } as typeof Element.prototype.querySelector;

    const getBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function countedGetBoundingClientRect() {
      // The jump rail only navigates user rows. Live assistant rows also carry
      // data-message-id, but the independent tail-follow animation legitimately
      // reads their geometry and its frame timing varies by platform.
      if (this instanceof HTMLElement && this.matches(".user-message-wrap[data-message-id]")) {
        metrics.messageTargetRectReads += 1;
      }
      return getBoundingClientRect.call(this);
    };
  });
}

async function readMessageTargetRectReads(page: Page): Promise<number> {
  return page.evaluate(() => (
    (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
      .__JASMINE_JUMP_RAIL_METRICS__?.messageTargetRectReads ?? -1
  ));
}

async function resetMessageTargetRectReads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const metrics = (window as Window & { __JASMINE_JUMP_RAIL_METRICS__?: JumpRailMetrics })
      .__JASMINE_JUMP_RAIL_METRICS__;
    if (metrics) metrics.messageTargetRectReads = 0;
  });
}
