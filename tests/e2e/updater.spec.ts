import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  launchJasmine,
  openSettings,
  quitElectron,
  type HarnessApp
} from "./helpers";

const require = createRequire(import.meta.url);
const packageMetadata = require("../../package.json") as { version: string };

test.describe("Jasmine app updater", () => {
  let harness: HarnessApp;

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("About checks, downloads, and requests installation through the updater bridge @smoke", async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"), undefined, {
      JASMINE_E2E_FAKE_UPDATER: "available",
      JASMINE_E2E_FAKE_UPDATE_VERSION: "9.9.9"
    });
    const { page } = harness;

    await openSettings(page, "About");
    await expect(page.getByTestId("app-current-version")).toHaveText(packageMetadata.version);
    await page.getByRole("button", { name: "Check for updates" }).click();
    await expect(page.getByText("Version 9.9.9 is available.")).toBeVisible();

    await page.getByRole("button", { name: "Download update" }).click();
    await expect(page.getByText("Version 9.9.9 is ready to install.")).toBeVisible();
    await page.getByRole("button", { name: "Restart and install" }).click();
    await expect(page.getByText("Jasmine is restarting to install the update.")).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.getAppUpdateState()).phase)).toBe("installing");
  });

  test("About offers the download page when the build cannot install updates itself", async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"), undefined, {
      JASMINE_E2E_FAKE_UPDATER: "available",
      JASMINE_E2E_FAKE_UPDATE_VERSION: "9.9.9",
      JASMINE_E2E_UPDATE_INSTALL_MODE: "manual"
    });
    const { page } = harness;

    // Stub the shell so the click is exercised for real without opening a
    // browser. Asserting only that the button renders would miss a bridge that
    // never reaches the main process.
    await harness.app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as Record<string, unknown>).__openedExternally = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });

    await openSettings(page, "About");
    await page.getByRole("button", { name: "Check for updates" }).click();
    await expect(page.getByText("Version 9.9.9 is available on GitHub Releases.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Download update" })).toHaveCount(0);

    await page.getByRole("button", { name: "Open download page" }).click();
    await expect
      .poll(() => harness.app.evaluate(() => (globalThis as Record<string, string[]>).__openedExternally ?? []))
      .toEqual(["https://github.com/ArtificialNotImbecile/pi-desktop/releases/latest"]);

    // A browser hand-off that fails leaves the user with no other route, so the
    // destination has to stay visible rather than vanish into a dropped promise.
    await harness.app.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw new Error("no usable browser handler");
      };
    });
    await page.getByRole("button", { name: "Open download page" }).click();
    const failure = page.locator(".about-update-error");
    await expect(failure).toContainText("https://github.com/ArtificialNotImbecile/pi-desktop/releases/latest");
    await expect(failure).toContainText("no usable browser handler");
  });

  test("About reports an up-to-date installed build", async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"), undefined, {
      JASMINE_E2E_FAKE_UPDATER: "up-to-date"
    });
    const { page } = harness;

    await openSettings(page, "About");
    await page.getByRole("button", { name: "Check for updates" }).click();
    await expect(page.getByText("Jasmine is up to date.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  });
});
