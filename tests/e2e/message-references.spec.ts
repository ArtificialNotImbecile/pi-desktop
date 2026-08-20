import { expect, test } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createRedSquarePng,
  launchJasmine,
  quitElectron,
  seedAssistantAnswer,
  type HarnessApp
} from "./helpers";

/**
 * References an assistant answer writes as Markdown -- a local image, a local
 * file, a web link -- and the behaviour behind them.
 *
 * These cases live here rather than in the renderer suite because each one
 * needs something jsdom does not have: a real custom protocol routing a real
 * request, Chromium actually decoding an image and reporting its natural size,
 * and the Electron `shell` a click is supposed to reach.
 */
test.describe("references in an assistant answer", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("paints a local image over the app's own protocol and opens it in a lightbox", async () => {
    const { page, userDataDir } = harness;
    const imagePath = await createRedSquarePng(userDataDir);
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Image reference" }));
    seedAssistantAnswer(
      userDataDir,
      thread.id,
      "reference-image",
      `Here is the chart.\n\n![Revenue chart](${imagePath.replace(/\\/g, "/")})`
    );
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /Image reference/ }).click();

    const image = page.locator(".message-image img");
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("src", /^jasmine-file:\/\/local\//);

    // Decoded by Chromium, not merely present in the DOM: a broken image would
    // still be visible and still carry its src.
    await expect.poll(async () => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Open image preview" }).click();
    await expect(page.locator(".image-lightbox")).toBeVisible();
    await expect(page.locator(".image-lightbox img")).toHaveAttribute("src", /^jasmine-file:\/\/local\//);
  });

  test("refuses to serve a non-image path over that protocol", async () => {
    const { page, userDataDir } = harness;
    const secretPath = path.join(userDataDir, "not-an-image.txt");
    await writeFile(secretPath, "TOP SECRET CONTENTS");

    const target = `jasmine-file://local${secretPath.replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`;

    // The scheme carries its own origin, so page script cannot read bytes back
    // out of it at all -- the request is rejected before the handler is reached.
    const fetched = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url);
        return { blocked: false, body: await response.text() };
      } catch {
        return { blocked: true, body: "" };
      }
    }, target);
    expect(fetched.blocked).toBe(true);
    expect(fetched.body).not.toContain("TOP SECRET");

    // And through the one context that is allowed to load it, a non-image is
    // refused rather than decoded, so nothing paints either.
    const decoded = await page.evaluate((url) => {
      return new Promise<boolean>((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(probe.naturalWidth > 0);
        probe.onerror = () => resolve(false);
        probe.src = url;
      });
    }, target);
    expect(decoded).toBe(false);
  });

  test("renders a local file as a chip and opens it with the system default application", async () => {
    const { page, userDataDir } = harness;
    const docPath = path.join(userDataDir, "quarterly report.docx");
    await writeFile(docPath, "seeded document");
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "File reference" }));
    seedAssistantAnswer(
      userDataDir,
      thread.id,
      "reference-file",
      `Saved to [quarterly report.docx](<${docPath.replace(/\\/g, "/")}>).`
    );
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /File reference/ }).click();

    const chip = page.locator(".file-reference");
    await expect(chip).toBeVisible();
    await expect(chip.locator(".file-reference-badge")).toHaveText("DOCX");
    await expect(chip).toHaveAttribute("data-category", "document");
    // The chip has to stay inside the message column rather than widening it.
    const columnWidth = await page.locator(".markdown-message").first().evaluate((node) => node.clientWidth);
    expect((await chip.boundingBox())!.width).toBeLessThanOrEqual(columnWidth + 1);

    // Armed before the click, awaited after it: the hook only settles once the
    // click has travelled all the way to the main process.
    const opened = harness.app.evaluate(({ shell }) => {
      return new Promise<string>((resolve) => {
        const originalOpenPath = shell.openPath.bind(shell);
        shell.openPath = async (target: string) => {
          shell.openPath = originalOpenPath;
          resolve(target);
          return "";
        };
      });
    });
    await chip.click();
    expect(path.resolve(await opened)).toBe(path.resolve(docPath));
  });

  test("hands a web link to the OS browser instead of opening a window", async () => {
    const { page, userDataDir } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Link reference" }));
    seedAssistantAnswer(userDataDir, thread.id, "reference-link", "See the [docs](https://example.com/docs).");
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /Link reference/ }).click();

    const opened = harness.app.evaluate(({ shell }) => {
      return new Promise<string>((resolve) => {
        const originalOpenExternal = shell.openExternal.bind(shell);
        shell.openExternal = async (target: string) => {
          shell.openExternal = originalOpenExternal;
          resolve(target);
        };
      });
    });
    const windowsBefore = await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

    await page.locator("a.message-link").click();
    expect(await opened).toBe("https://example.com/docs");
    expect(await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowsBefore);
    // The renderer itself must not have navigated away from the app shell.
    await expect(page.locator(".app-shell")).toBeVisible();
  });

  test("degrades a path that is not there to an inert chip rather than a broken image", async () => {
    const { page, userDataDir } = harness;
    const thread = await page.evaluate(() => window.jasmine.createThread({ title: "Missing reference" }));
    seedAssistantAnswer(
      userDataDir,
      thread.id,
      "reference-missing",
      `![gone](${path.join(userDataDir, "absent.png").replace(/\\/g, "/")})`
    );
    await page.reload();
    await page.waitForSelector(".app-shell");
    await page.getByRole("button", { name: /Missing reference/ }).click();

    const chip = page.locator(".file-reference");
    await expect(chip).toBeVisible();
    await expect(chip).toBeDisabled();
    await expect(chip).toHaveAttribute("data-missing", "true");
    await expect(page.locator(".message-image")).toHaveCount(0);
  });
});
