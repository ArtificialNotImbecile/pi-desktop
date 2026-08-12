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

test.describe("Jasmine integrations", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("skills can be selected from chat commands and the Skills menu", async () => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);

    const textarea = page.locator(".rich-composer-editor");
    await textarea.fill("$tech");
    await expect(page.locator(".skill-command-menu")).toBeVisible();
    await expect(page.locator(".skill-command-menu")).toContainText("$technical-writer");
    await expectFloatingMenuInViewport(page, ".skill-command-menu", ".rich-composer-editor");
    await page.locator(".skill-command-menu").getByRole("option", { name: /technical-writer/ }).click();
    await expect(page.locator(".inline-skill-row")).toContainText("technical-writer");
    await expect(page.locator(".skill-tool")).not.toHaveClass(/active/);
    await expectComposerEditorText(textarea, "");

    await page.getByRole("button", { name: "Skills" }).click();
    await expect(page.locator(".skill-menu")).toBeVisible();
    await expectFloatingMenuInViewport(page, ".skill-menu", ".skill-tool");
    await expect(page.locator(".skill-menu").getByRole("button", { name: /technical-writer/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".skill-menu")).toBeHidden();

    await textarea.fill("slow response use skill for this answer");
    await page.getByRole("button", { name: "Send" }).click();
    const inlineSkillUser = page.locator(".user-message-wrap").last();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible({ timeout: 500 });
    const optimisticSkillState = await inlineSkillUser.evaluate((node) => {
      (window as typeof window & { __JASMINE_INLINE_SKILL_USER_NODE__?: Element }).__JASMINE_INLINE_SKILL_USER_NODE__ = node;
      return {
        badgeText: node.querySelector('[aria-label="Inline skills"]')?.textContent ?? "",
        finalReplyPresent: Array.from(document.querySelectorAll(".assistant-block"))
          .some((assistant) => assistant.textContent?.includes("Inline skill reply using technical-writer.")),
        running: document.querySelector('button[aria-label="Stop response"]') !== null
      };
    });
    expect(optimisticSkillState).toEqual({
      badgeText: expect.stringContaining("technical-writer"),
      finalReplyPresent: false,
      running: true
    });
    await waitForStableAssistant(page, "Inline skill reply using technical-writer.");
    expect(await page.evaluate(() => (
      (window as typeof window & { __JASMINE_INLINE_SKILL_USER_NODE__?: Element }).__JASMINE_INLINE_SKILL_USER_NODE__
      === Array.from(document.querySelectorAll(".user-message-wrap")).at(-1)
    ))).toBe(true);
    await page.getByRole("button", { name: "Open Context taxonomy" }).click();
    const inlinePromptTaxonomy = page.locator(".taxonomy-item", { hasText: "Current user prompt" }).last();
    await expect(inlinePromptTaxonomy).toContainText("Explicit User Selected Skills");
    await expect(inlinePromptTaxonomy).toContainText("When this skill is active");
    await page.getByRole("button", { name: "Close Context taxonomy tab" }).click();
    await inlineSkillUser.hover();
    await inlineSkillUser.getByRole("button", { name: "Edit message" }).click();
    await expect(page.locator(".edit-banner")).toContainText("Editing message");
    await textarea.fill("$tech");
    await page.locator(".skill-command-menu").getByRole("option", { name: /technical-writer/ }).click();
    await textarea.fill("slow response use skill for edited answer");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible({ timeout: 500 });
    const optimisticEditedSkillState = await inlineSkillUser.evaluate((node) => ({
      badgeText: node.querySelector('[aria-label="Inline skills"]')?.textContent ?? "",
      finalReplyPresent: Array.from(document.querySelectorAll(".assistant-block"))
        .some((assistant) => assistant.textContent?.includes("Inline skill reply using technical-writer.")),
      running: document.querySelector('button[aria-label="Stop response"]') !== null,
      sameUserNode: (window as typeof window & { __JASMINE_INLINE_SKILL_USER_NODE__?: Element }).__JASMINE_INLINE_SKILL_USER_NODE__ === node
    }));
    expect(optimisticEditedSkillState).toEqual({
      badgeText: expect.stringContaining("technical-writer"),
      finalReplyPresent: false,
      running: true,
      sameUserNode: true
    });
    await waitForStableAssistant(page, "Inline skill reply using technical-writer.");
    expect(await page.evaluate(() => (
      (window as typeof window & { __JASMINE_INLINE_SKILL_USER_NODE__?: Element }).__JASMINE_INLINE_SKILL_USER_NODE__
      === Array.from(document.querySelectorAll(".user-message-wrap")).at(-1)
    ))).toBe(true);
    await page.getByRole("button", { name: "Skills" }).click();
    await page.locator(".skill-menu").getByRole("button", { name: /technical-writer/ }).click();
    await expect(page.locator(".skill-tool")).toHaveClass(/active/);
    await textarea.fill("use skill manifest for this answer");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Skill-aware reply using technical-writer.");
    await expect(page.locator(".assistant-block").last().getByLabel("Skills used")).toContainText("technical-writer");
    const localSkillFile = path.join(userDataDir, "skills", "local", "technical-writer", "SKILL.md");
    await access(localSkillFile);
    const localSkillText = await readFile(localSkillFile, "utf8");
    expect(localSkillText).toContain("name: \"technical-writer\"");
    expect(localSkillText).toContain("When this skill is active");

  });

  test("skills settings manages external folders and local skill lifecycle", async () => {
    const { page, userDataDir } = harness;

    await openSettings(page, "Skills");
    await expect(page.locator(".settings-panel")).toBeVisible();
    await expect(page.locator(".settings-nav").getByRole("button", { name: "Skills" })).toHaveClass(/active/);
    await expect(page.locator(".settings-detail")).not.toContainText("Runtime behavior");
    await expect(page.locator(".settings-detail")).not.toContainText("Available skills");
    await expect(page.locator(".skill-settings-toolbar").getByRole("textbox", { name: "Search skills" })).toBeVisible();

    const externalSkillRoot = await createExternalSkillFixture(userDataDir);
    await page.getByRole("button", { name: "Add Folder" }).click();
    const sourceRow = page.locator(".skill-source-row", { hasText: externalSkillRoot });
    await expect(sourceRow).toBeVisible();
    await expect(sourceRow.getByRole("button", { name: "Refresh" })).toBeVisible();
    const externalRow = page.locator(".skill-settings-row", { hasText: "ui-ux-product-harness" });
    await expect(externalRow).toBeVisible();
    await expect(externalRow).toContainText("External");
    await expect(page.locator(".skill-list-heading", { hasText: "Local" })).toBeVisible();
    await expect(page.locator(".skill-list-heading", { hasText: "External" })).toBeVisible();
    await expect(externalRow.locator(".skill-row-icon")).toHaveCount(1);
    await expect(page.locator(".skill-settings-row", { hasText: "technical-writer" }).locator(".skill-row-icon")).toHaveCount(1);
    await expect(page.locator(".skill-settings-row", { hasText: "ignored-system-skill" })).toHaveCount(0);
    await expect(page.locator(".skill-settings-row", { hasText: "mismatched-skill-name" })).toHaveCount(0);
    await externalRow.getByRole("switch", { name: "Disable ui-ux-product-harness" }).click();
    await expect(externalRow).toContainText("Disabled");
    await expect(externalRow.getByRole("button", { name: "Select" })).toBeDisabled();
    await sourceRow.getByRole("button", { name: "Refresh" }).click();
    await expect(externalRow).toContainText("Disabled");
    await externalRow.getByRole("switch", { name: "Enable ui-ux-product-harness" }).click();
    await expect(externalRow.getByRole("button", { name: "Select" })).toBeEnabled();
    await externalRow.getByRole("button", { name: "Select" }).click();
    await expect(externalRow).toHaveClass(/selected/);
    await sourceRow.getByRole("button", { name: "Refresh" }).click();
    await expect(externalRow).toBeVisible();
    await page.getByRole("textbox", { name: "Search skills" }).fill("ui-ux");
    await expect(externalRow).toBeVisible();
    await expect(page.locator(".skill-settings-row", { hasText: "technical-writer" })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Search skills" }).fill("not-a-skill");
    await expect(page.locator(".skill-settings-empty")).toHaveText("No matching skills.");
    await page.getByRole("textbox", { name: "Search skills" }).fill("");

    await page.getByRole("button", { name: "New Skill" }).click();
    await expectNoPurpleThemeColors(page.locator(".settings-panel"), "skills settings page");
    await expect(page.locator(".skill-editor")).toHaveCount(0);
    const newSkillFile = path.join(userDataDir, "skills", "local", "new-skill", "SKILL.md");
    await expect.poll(async () => readFile(newSkillFile, "utf8").catch(() => "")).toContain("name: \"new-skill\"");
    const editorLog = path.join(userDataDir, "editor-open.log");
    await expect.poll(async () => readFile(editorLog, "utf8").catch(() => "")).toContain(newSkillFile);
    await page.getByRole("button", { name: "Refresh" }).first().click();
    await expect(page.locator(".skill-settings-row", { hasText: "new-skill" })).toBeVisible();

    const releaseRow = page.locator(".skill-settings-row", { hasText: "new-skill" });
    await releaseRow.getByRole("switch", { name: "Disable new-skill" }).click();
    await expect(releaseRow).toContainText("Disabled");
    const skillNamesAfterDisable = await page.locator(".skill-settings-row strong").allTextContents();
    expect(skillNamesAfterDisable.indexOf("new-skill")).toBeLessThan(skillNamesAfterDisable.indexOf("technical-writer"));
    await releaseRow.getByRole("switch", { name: "Enable new-skill" }).click();
    await releaseRow.getByRole("button", { name: "Select" }).click();
    await expect(releaseRow).toHaveClass(/selected/);
    await expectNoPurpleThemeColors(page.locator(".settings-panel"), "selected skill settings page");
    await releaseRow.getByRole("button", { name: "Open" }).click();
    await expect.poll(async () => readFile(editorLog, "utf8").catch(() => "")).toContain(newSkillFile);
    await releaseRow.getByRole("button", { name: "Delete new-skill" }).click();
    await expect(page.locator(".confirm-dialog")).toBeVisible();
    await page.locator(".confirm-dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(releaseRow).toBeVisible();
    await releaseRow.getByRole("button", { name: "Delete new-skill" }).click();
    await page.locator(".confirm-dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator(".skill-settings-row", { hasText: "new-skill" })).toHaveCount(0);
    await expect.poll(async () => access(newSkillFile).then(() => "exists").catch(() => "missing")).toBe("missing");
  });

  test("prompt templates can be managed in settings and inserted with slash commands", async () => {
    const { page, userDataDir } = harness;
    await startEmptyThread(page);
    const promptTemplateSource = await createPromptTemplateFixture(userDataDir);

    await openSettings(page, "Prompt Templates");
    await expect(page.locator(".settings-detail")).toContainText("Local prompt templates");
    const promptToolbar = page.locator(".prompt-settings-toolbar");
    await expect(promptToolbar).toBeVisible();
    const toolbarLayout = await promptToolbar.evaluate((element) => {
      const search = element.querySelector(".skill-search-control")?.getBoundingClientRect();
      const searchField = element.querySelector(".skill-search-control");
      const searchIcon = element.querySelector(".skill-search-control .ui-field-icon")?.getBoundingClientRect();
      const searchInput = element.querySelector(".skill-search-control input");
      const fieldRect = searchField?.getBoundingClientRect();
      const inputPaddingLeft = searchInput instanceof HTMLElement ? Number.parseFloat(getComputedStyle(searchInput).paddingLeft) : 0;
      const refresh = element.querySelector("button:nth-of-type(1)")?.getBoundingClientRect();
      const add = element.querySelector("button:nth-of-type(2)")?.getBoundingClientRect();
      return {
        searchTop: Math.round(search?.top ?? 0),
        iconTextGap: Math.round(inputPaddingLeft - ((searchIcon?.right ?? 0) - (fieldRect?.left ?? 0))),
        refreshTop: Math.round(refresh?.top ?? 0),
        addTop: Math.round(add?.top ?? 0),
        addWidth: Math.round(add?.width ?? 0),
        toolbarWidth: Math.round(element.getBoundingClientRect().width)
      };
    });
    expect(Math.abs(toolbarLayout.searchTop - toolbarLayout.refreshTop)).toBeLessThanOrEqual(2);
    expect(Math.abs(toolbarLayout.searchTop - toolbarLayout.addTop)).toBeLessThanOrEqual(2);
    expect(toolbarLayout.iconTextGap).toBeGreaterThanOrEqual(6);
    expect(toolbarLayout.addWidth).toBeLessThan(toolbarLayout.toolbarWidth / 2);
    await page.getByRole("button", { name: "Add Source" }).click();
    const sourceRow = page.locator(".prompt-source-row", { hasText: promptTemplateSource });
    await expect(sourceRow).toBeVisible();
    await expect(sourceRow.locator(".prompt-source-icon")).toBeVisible();
    await expect(page.locator(".prompt-template-row", { hasText: "/triage" })).toBeVisible();
    await expect(page.locator(".prompt-template-row", { hasText: "<issue>" })).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();

    const textarea = page.locator(".rich-composer-editor");
    await textarea.fill("/tri");
    await expect(page.locator(".slash-command-menu")).toBeVisible();
    await expect(page.locator(".slash-command-menu")).toContainText("/triage");
    await expectFloatingMenuInViewport(page, ".slash-command-menu", ".rich-composer-editor");
    await page.locator(".slash-command-menu").getByRole("option", { name: /triage/ }).click();
    await expectComposerEditorText(textarea, "/triage ");
  });

  test("packages settings migrates the retired Chrome bundle and manages a local Pi package", async () => {
    let { page, userDataDir } = harness;
    const packageSource = await createPiPluginFixture(userDataDir);
    const secondaryPackageSource = path.join(userDataDir, "plugin-fixtures", "zeta-e2e-plugin");
    await mkdir(secondaryPackageSource, { recursive: true });
    await writeFile(path.join(secondaryPackageSource, "package.json"), JSON.stringify({
      name: "zeta-e2e-plugin",
      version: "1.0.0",
      type: "module",
      pi: { extensions: ["./extension.js"] }
    }, null, 2), "utf8");
    await writeFile(path.join(secondaryPackageSource, "extension.js"), "export default function zetaE2ePlugin() {}\n", "utf8");
    const piWebAccessRoot = path.join(rootDir, "node_modules", "pi-web-access");
    const piWebAccessAgentDir = path.join(userDataDir, "pi-agent");
    await quitElectron(harness.app);
    const retiredChromeDir = path.join(userDataDir, "plugins", "chrome");
    await mkdir(path.join(retiredChromeDir, "skills", "chrome"), { recursive: true });
    await writeFile(path.join(retiredChromeDir, "package.json"), JSON.stringify({
      name: "chrome",
      version: "0.1.0",
      type: "module",
      pi: { extensions: ["./index.js"], skills: ["./skills"] }
    }, null, 2), "utf8");
    await writeFile(path.join(retiredChromeDir, "index.js"), "export default function chrome() {}\n", "utf8");
    await writeFile(path.join(retiredChromeDir, "skills", "chrome", "SKILL.md"), "---\nname: chrome\ndescription: retired fixture\n---\n", "utf8");
    await seedPiAgentPackageSettings(userDataDir, [
      { source: piWebAccessRoot, extensions: [], skills: [], prompts: [], themes: [] },
      path.relative(piWebAccessAgentDir, piWebAccessRoot),
      secondaryPackageSource,
      "chrome"
    ]);
    harness = await launchJasmine("plugins-legacy-pi-web-access", userDataDir);
    page = harness.page;

    await openSettings(page, "Packages");
    await expect(page.locator(".settings-detail")).toContainText("Pi Web Access");
    await expect(page.locator(".settings-detail").getByRole("menuitemcheckbox")).toHaveCount(0);
    const rowTitles = await page.locator(".plugin-row").evaluateAll((rows) =>
      rows.map((row) => row.querySelector(":scope > .ui-settings-list-main > strong")?.textContent?.trim() ?? "").filter(Boolean)
    );
    expect(rowTitles.filter((title) => title.trim() === "Pi Web Access")).toHaveLength(1);
    expect(rowTitles.some((title) => title.trim() === "pi-web-access")).toBe(false);
    const piWebAccessRow = page.locator(".plugin-row", { hasText: "Pi Web Access" });
    await expect(piWebAccessRow).toContainText("Enabled");
    await expect(piWebAccessRow).toContainText("ext 1");
    await expect(piWebAccessRow).toContainText("skills 1");
    expect(rowTitles.filter((title) => title.trim() === "Chrome")).toHaveLength(0);
    await expect(access(retiredChromeDir)).rejects.toThrow();

    await page.locator(".plugins-toolbar").getByRole("button", { name: "Choose folder..." }).click();
    await expect(page.getByRole("textbox", { name: "Pi package source" })).toHaveValue(packageSource);
    await page.locator(".plugins-toolbar").getByRole("button", { name: "Install" }).click();
    const row = page.locator(".plugin-row", { hasText: "jasmine-e2e-plugin" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("ext 1");
    await expect(row).toContainText("skills 1");
    await expect(row).toContainText("Enabled");
    const selectedPackageOrder = (await page.locator(".plugin-row").evaluateAll((rows) => rows
      .map((pluginRow) => pluginRow.querySelector(":scope > .ui-settings-list-main > strong")?.textContent?.trim() ?? "")
      .filter((name) => name === "jasmine-e2e-plugin" || name === "zeta-e2e-plugin")));
    expect(selectedPackageOrder).toHaveLength(2);

    await page.getByRole("button", { name: "Close settings" }).click();
    const textarea = page.locator(".rich-composer-editor");
    await textarea.fill("$jasmine");
    await expect(page.locator(".skill-command-menu")).toBeVisible();
    await expect(page.locator(".skill-command-menu")).toContainText("$jasmine-e2e");
    await page.locator(".skill-command-menu").getByRole("option", { name: /jasmine-e2e/ }).click();
    await expect(page.locator(".inline-skill-row")).toContainText("jasmine-e2e");
    await expectComposerEditorText(textarea, "");
    await textarea.fill("$tech");
    await page.locator(".skill-command-menu").getByRole("option", { name: /technical-writer/ }).click();
    const canonicalMixedSkillOrder = ["technical-writer", "jasmine-e2e"];
    expect(await page.locator(".inline-skill-row button span").allTextContents()).toEqual([...canonicalMixedSkillOrder].reverse());
    await textarea.fill("slow response mixed skill reference ordering");
    await page.getByRole("button", { name: "Send" }).click();
    const mixedSkillUser = page.locator(".user-message-wrap").last();
    const mixedSkillReply = "Inline skill reply using technical-writer, jasmine-e2e.";
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible({ timeout: 500 });
    const optimisticMixedSkillState = await mixedSkillUser.evaluate((node) => {
      const scope = window as typeof window & {
        __JASMINE_MIXED_SKILL_USER_NODE__?: Element;
        __JASMINE_MIXED_SKILL_BADGE_NODES__?: Element[];
      };
      const badges = Array.from(node.querySelectorAll('[aria-label="Inline skills"] > span'));
      scope.__JASMINE_MIXED_SKILL_USER_NODE__ = node;
      scope.__JASMINE_MIXED_SKILL_BADGE_NODES__ = badges;
      return {
        badgeNames: badges.map((badge) => badge.textContent?.trim() ?? ""),
        finalReplyPresent: Array.from(document.querySelectorAll(".assistant-block"))
          .some((assistant) => assistant.textContent?.includes("Inline skill reply using technical-writer, jasmine-e2e.")),
        running: document.querySelector('button[aria-label="Stop response"]') !== null
      };
    });
    expect(optimisticMixedSkillState).toEqual({
      badgeNames: canonicalMixedSkillOrder,
      finalReplyPresent: false,
      running: true
    });
    await waitForStableAssistant(page, mixedSkillReply);
    const settledMixedSkillState = await mixedSkillUser.evaluate((node) => {
      const scope = window as typeof window & {
        __JASMINE_MIXED_SKILL_USER_NODE__?: Element;
        __JASMINE_MIXED_SKILL_BADGE_NODES__?: Element[];
      };
      const badges = Array.from(node.querySelectorAll('[aria-label="Inline skills"] > span'));
      return {
        badgeNames: badges.map((badge) => badge.textContent?.trim() ?? ""),
        sameBadgeNodes: badges.every((badge, index) => scope.__JASMINE_MIXED_SKILL_BADGE_NODES__?.[index] === badge),
        sameUserNode: scope.__JASMINE_MIXED_SKILL_USER_NODE__ === node
      };
    });
    expect(settledMixedSkillState).toEqual({
      badgeNames: canonicalMixedSkillOrder,
      sameBadgeNodes: true,
      sameUserNode: true
    });

    await mixedSkillUser.hover();
    await mixedSkillUser.getByRole("button", { name: "Edit message" }).click();
    await expect(page.locator(".edit-banner")).toContainText("Editing message");
    for (const skillName of canonicalMixedSkillOrder) {
      await page.locator(".inline-skill-row").getByRole("button", { name: new RegExp(skillName, "i") }).click();
    }
    for (const skillQuery of ["$jasmine", "$tech"]) {
      await textarea.fill(skillQuery);
      await page.locator(".skill-command-menu").getByRole("option").filter({ hasText: skillQuery === "$jasmine" ? "jasmine-e2e" : "technical-writer" }).click();
    }
    expect(await page.locator(".inline-skill-row button span").allTextContents()).toEqual([...canonicalMixedSkillOrder].reverse());
    await textarea.fill("slow response edited mixed skill reference ordering");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible({ timeout: 500 });
    const optimisticEditedMixedSkillState = await mixedSkillUser.evaluate((node) => {
      const scope = window as typeof window & {
        __JASMINE_MIXED_SKILL_USER_NODE__?: Element;
        __JASMINE_MIXED_SKILL_BADGE_NODES__?: Element[];
      };
      const badges = Array.from(node.querySelectorAll('[aria-label="Inline skills"] > span'));
      return {
        badgeNames: badges.map((badge) => badge.textContent?.trim() ?? ""),
        finalReplyPresent: Array.from(document.querySelectorAll(".assistant-block"))
          .some((assistant) => assistant.textContent?.includes("Inline skill reply using technical-writer, jasmine-e2e.")),
        running: document.querySelector('button[aria-label="Stop response"]') !== null,
        sameBadgeNodes: badges.every((badge, index) => scope.__JASMINE_MIXED_SKILL_BADGE_NODES__?.[index] === badge),
        sameUserNode: scope.__JASMINE_MIXED_SKILL_USER_NODE__ === node
      };
    });
    expect(optimisticEditedMixedSkillState).toEqual({
      badgeNames: canonicalMixedSkillOrder,
      finalReplyPresent: false,
      running: true,
      sameBadgeNodes: true,
      sameUserNode: true
    });
    await waitForStableAssistant(page, mixedSkillReply);
    const settledEditedMixedSkillState = await mixedSkillUser.evaluate((node) => {
      const scope = window as typeof window & { __JASMINE_MIXED_SKILL_BADGE_NODES__?: Element[] };
      const badges = Array.from(node.querySelectorAll('[aria-label="Inline skills"] > span'));
      return {
        badgeNames: badges.map((badge) => badge.textContent?.trim() ?? ""),
        sameBadgeNodes: badges.every((badge, index) => scope.__JASMINE_MIXED_SKILL_BADGE_NODES__?.[index] === badge)
      };
    });
    expect(settledEditedMixedSkillState).toEqual({ badgeNames: canonicalMixedSkillOrder, sameBadgeNodes: true });

    await openSettings(page, "Packages");
    await row.getByRole("switch", { name: /Disable jasmine-e2e-plugin/ }).click();
    await expect(row).toContainText("Disabled");

    await page.getByRole("button", { name: "Close settings" }).click();
    // Select packages in the reverse of the main process's canonical package
    // order. The optimistic sent row must already use canonical order so the
    // settlement cannot visibly reorder its badges.
    for (const packageName of [...selectedPackageOrder].reverse()) {
      await textarea.fill(`@${packageName}`);
      await expect(page.locator(".mention-menu")).toBeVisible();
      const mentionRow = page.locator(".mention-row", { hasText: `@${packageName}` });
      await expect(mentionRow).toBeVisible();
      await mentionRow.click();
      await expectComposerEditorText(textarea, "");
    }
    const composerPackageOrder = await page.locator(".inline-plugin-row button span").allTextContents();
    expect(composerPackageOrder).toEqual([...selectedPackageOrder].reverse());
    await textarea.fill("slow response use temporary plugin package");
    await page.getByRole("button", { name: "Send" }).click();
    const inlinePluginUser = page.locator(".user-message-wrap").last();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible({ timeout: 500 });
    const optimisticPluginState = await inlinePluginUser.evaluate((node) => {
      const scope = window as typeof window & {
        __JASMINE_INLINE_PLUGIN_USER_NODE__?: Element;
        __JASMINE_INLINE_PLUGIN_BADGE_NODES__?: Element[];
      };
      const badges = Array.from(node.querySelectorAll('[aria-label="Active packages"] > span'));
      scope.__JASMINE_INLINE_PLUGIN_USER_NODE__ = node;
      scope.__JASMINE_INLINE_PLUGIN_BADGE_NODES__ = badges;
      return {
        badgeNames: badges.map((badge) => badge.textContent?.trim() ?? ""),
        finalReplyPresent: Array.from(document.querySelectorAll(".assistant-block"))
          .some((assistant) => assistant.textContent?.includes("Slow response complete.")),
        running: document.querySelector('button[aria-label="Stop response"]') !== null
      };
    });
    expect(optimisticPluginState).toEqual({
      badgeNames: selectedPackageOrder,
      finalReplyPresent: false,
      running: true
    });
    await waitForStableAssistant(page, "Slow response complete.");
    const settledPluginState = await inlinePluginUser.evaluate((node) => {
      const scope = window as typeof window & {
        __JASMINE_INLINE_PLUGIN_USER_NODE__?: Element;
        __JASMINE_INLINE_PLUGIN_BADGE_NODES__?: Element[];
      };
      const badges = Array.from(node.querySelectorAll('[aria-label="Active packages"] > span'));
      return {
        badgeNames: badges.map((badge) => badge.textContent?.trim() ?? ""),
        sameBadgeNodes: badges.every((badge, index) => scope.__JASMINE_INLINE_PLUGIN_BADGE_NODES__?.[index] === badge),
        sameUserNode: scope.__JASMINE_INLINE_PLUGIN_USER_NODE__ === node
      };
    });
    expect(settledPluginState).toEqual({
      badgeNames: selectedPackageOrder,
      sameBadgeNodes: true,
      sameUserNode: true
    });
    await expect(page.locator(".inline-plugin-row")).toContainText("jasmine-e2e-plugin");
    await expect(page.locator(".assistant-block").last().getByLabel("Packages used")).toContainText("jasmine-e2e-plugin");
    await inlinePluginUser.hover();
    await inlinePluginUser.getByRole("button", { name: "Edit message" }).click();
    await expect(page.locator(".edit-banner")).toContainText("Editing message");
    for (const packageName of selectedPackageOrder) {
      await page.locator(".inline-plugin-row").getByRole("button", { name: new RegExp(packageName, "i") }).click();
    }
    for (const packageName of [...selectedPackageOrder].reverse()) {
      await textarea.fill(`@${packageName}`);
      await page.locator(".mention-row", { hasText: `@${packageName}` }).click();
    }
    expect(await page.locator(".inline-plugin-row button span").allTextContents()).toEqual([...selectedPackageOrder].reverse());
    await textarea.fill("slow response edit temporary plugin package");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible({ timeout: 500 });
    const optimisticEditedPluginState = await inlinePluginUser.evaluate((node) => {
      const scope = window as typeof window & {
        __JASMINE_INLINE_PLUGIN_USER_NODE__?: Element;
        __JASMINE_INLINE_PLUGIN_BADGE_NODES__?: Element[];
      };
      const badges = Array.from(node.querySelectorAll('[aria-label="Active packages"] > span'));
      return {
        badgeNames: badges.map((badge) => badge.textContent?.trim() ?? ""),
        finalReplyPresent: Array.from(document.querySelectorAll(".assistant-block"))
          .some((assistant) => assistant.textContent?.includes("Slow response complete.")),
        running: document.querySelector('button[aria-label="Stop response"]') !== null,
        sameBadgeNodes: badges.every((badge, index) => scope.__JASMINE_INLINE_PLUGIN_BADGE_NODES__?.[index] === badge),
        sameUserNode: scope.__JASMINE_INLINE_PLUGIN_USER_NODE__ === node
      };
    });
    expect(optimisticEditedPluginState).toEqual({
      badgeNames: selectedPackageOrder,
      finalReplyPresent: false,
      running: true,
      sameBadgeNodes: true,
      sameUserNode: true
    });
    await waitForStableAssistant(page, "Slow response complete.");
    const settledEditedPluginState = await inlinePluginUser.evaluate((node) => {
      const scope = window as typeof window & {
        __JASMINE_INLINE_PLUGIN_USER_NODE__?: Element;
        __JASMINE_INLINE_PLUGIN_BADGE_NODES__?: Element[];
      };
      const badges = Array.from(node.querySelectorAll('[aria-label="Active packages"] > span'));
      return {
        badgeNames: badges.map((badge) => badge.textContent?.trim() ?? ""),
        sameBadgeNodes: badges.every((badge, index) => scope.__JASMINE_INLINE_PLUGIN_BADGE_NODES__?.[index] === badge),
        sameUserNode: scope.__JASMINE_INLINE_PLUGIN_USER_NODE__ === node
      };
    });
    expect(settledEditedPluginState).toEqual({
      badgeNames: selectedPackageOrder,
      sameBadgeNodes: true,
      sameUserNode: true
    });
    await textarea.fill("continue with active plugin package");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".user-bubble").last().getByLabel("Active packages")).toContainText("jasmine-e2e-plugin");
    await expect(page.locator(".assistant-block").last().getByLabel("Packages used")).toContainText("jasmine-e2e-plugin");
    for (const packageName of selectedPackageOrder) {
      await page.locator(".inline-plugin-row").getByRole("button", { name: new RegExp(packageName, "i") }).click();
    }
    await expect(page.locator(".inline-plugin-row")).toHaveCount(0);
    await textarea.fill("continue without active plugin package");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".user-bubble").last().getByLabel("Active packages")).toHaveCount(0);
    await expect(page.locator(".assistant-block").last().getByLabel("Packages used")).toHaveCount(0);

    await openSettings(page, "Packages");
    await expect(row).toContainText("Disabled");
    await row.getByRole("button", { name: "Remove jasmine-e2e-plugin" }).click();
    await expect(row).toHaveCount(0);
  });
});
