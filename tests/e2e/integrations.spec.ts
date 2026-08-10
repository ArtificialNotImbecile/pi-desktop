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

test.describe("Jasmine integrations", () => {
  let harness: HarnessApp;

  test.beforeEach(async ({}, testInfo) => {
    harness = await launchJasmine(testInfo.title.replace(/\W+/g, "-"));
  });

  test.afterEach(async () => {
    if (harness?.app) await quitElectron(harness.app);
    if (harness?.userDataDir) await rm(harness.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test("MCP marketplace installs and manages local server records", async () => {
    const { page } = harness;

    await openSettings(page, "MCP Servers");
    await expect(page.locator(".settings-detail")).not.toContainText("Discover and manage Model Context Protocol servers");
    const marketplaceTab = page.locator(".mcp-tabbar").getByRole("tab", { name: "Marketplace" });
    const installedTab = page.locator(".mcp-tabbar").getByRole("tab", { name: /Installed/ });
    await expect(marketplaceTab).toHaveAttribute("aria-selected", "true");
    await marketplaceTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(installedTab).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(marketplaceTab).toHaveAttribute("aria-selected", "true");

    const context7Card = page.locator(".mcp-card", { hasText: "Context7" }).first();
    await expect(context7Card).toBeVisible();
    await context7Card.getByRole("button", { name: "Install" }).click();
    await expect(context7Card.getByRole("button", { name: "Installed" })).toBeDisabled();
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.listMcpServers()).some((server) => server.marketplaceId === "jasmine:context7"))).toBe(true);

    await page.locator(".mcp-tabbar").getByRole("tab", { name: /Installed/ }).click();
    const installedContext7 = page.locator(".mcp-card.installed", { hasText: "Context7" }).first();
    await expect(installedContext7).toBeVisible();
    await expect(installedContext7).toContainText("npx -y @upstash/context7-mcp");
    await installedContext7.getByRole("switch", { name: "Disable Context7" }).click();
    await expect(installedContext7.getByRole("switch", { name: "Enable Context7" })).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.listMcpServers()).find((server) => server.marketplaceId === "jasmine:context7")?.enabled)).toBe(false);
    await page.locator(".mcp-toolbar").getByRole("button", { name: "Refresh" }).click();
    await expect(installedContext7.getByRole("switch", { name: "Enable Context7" })).toHaveAttribute("aria-checked", "false");
    await installedContext7.getByRole("switch", { name: "Enable Context7" }).focus();
    await page.keyboard.press("Space");
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.listMcpServers()).find((server) => server.marketplaceId === "jasmine:context7")?.enabled)).toBe(true);

    await page.locator(".mcp-toolbar").getByRole("button", { name: "Add Server" }).click();
    const editor = page.locator(".mcp-editor");
    await expect(editor).toBeVisible();
    await editor.getByLabel("Name").fill("Local docs MCP");
    await editor.getByLabel("Description").fill("Private docs through MCP");
    await editor.getByLabel("Command", { exact: true }).fill("node");
    await editor.getByLabel("Arguments", { exact: true }).fill('"server path.js" --port 3300');
    await editor.getByLabel("Environment JSON", { exact: true }).fill(JSON.stringify({ DOCS_TOKEN: "secret-token" }));
    await editor.getByRole("button", { name: "Save Server" }).click();

    const manualRow = page.locator(".mcp-card.installed", { hasText: "Local docs MCP" }).first();
    await expect(manualRow).toBeVisible();
    await expect(manualRow).toContainText("node server path.js --port 3300");
    await expect(manualRow).toContainText("DOCS_TOKEN=****");
    await expect(manualRow).not.toContainText("secret-token");
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.listMcpServers()).some((server) => server.name === "Local docs MCP" && server.args.includes("server path.js")))).toBe(true);
    await manualRow.getByRole("button", { name: "Remove" }).click();
    await expect(manualRow).toHaveCount(0);
  });

  test("remote SSH connections import, activate, and reach chat runtime", async () => {
    const { page } = harness;

    await openSettings(page, "Remote");
    await expect(page.locator(".remote-list")).toContainText("No remote connections yet.");
    await expect(page.locator(".remote-tabs button", { hasText: "SSH" })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("button", { name: "Import from SSH Config" }).click();
    const importedRow = page.locator(".remote-row", { hasText: "vscode-dev" }).first();
    await expect(importedRow).toBeVisible();
    await expect(importedRow).toContainText("vscode-dev");
    // Pixel polish (borders/radius/gaps) lives in the visual harness; here we guard the
    // functional column ordering that keeps action buttons clear of the main content/status.
    const remoteLayout = await importedRow.evaluate((row) => {
      const rowActions = row.querySelector(".ui-settings-list-actions");
      const rowMain = row.querySelector(".ui-settings-list-main");
      const rowStatus = row.querySelector(".ui-settings-list-status");
      if (!(rowActions instanceof HTMLElement) || !(rowMain instanceof HTMLElement) || !(rowStatus instanceof HTMLElement)) throw new Error("Remote row layout missing.");
      const rowActionsBox = rowActions.getBoundingClientRect();
      const rowMainBox = rowMain.getBoundingClientRect();
      const rowStatusBox = rowStatus.getBoundingClientRect();
      return {
        actionsAfterMain: rowActionsBox.left > rowMainBox.right,
        statusBeforeActions: rowStatusBox.right <= rowActionsBox.left
      };
    });
    expect(remoteLayout.actionsAfterMain).toBe(true);
    expect(remoteLayout.statusBeforeActions).toBe(true);
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.listRemoteConnections()).some((connection) => connection.configHost === "vscode-dev"))).toBe(true);

    await page.getByRole("button", { name: "Add Remote" }).click();
    const editor = page.locator(".remote-editor");
    await expect(editor).toBeVisible();
    await editor.getByLabel("Name").fill("WSL project");
    await editor.getByLabel("Host").fill("127.0.0.1");
    await editor.getByLabel("User").fill("dev");
    await editor.getByLabel("Port").fill("2222");
    await editor.getByLabel("Remote path").fill("/home/dev/project");
    await editor.getByRole("button", { name: "Save Remote" }).click();

    const manualRow = page.locator(".remote-row", { hasText: "WSL project" }).first();
    await expect(manualRow).toBeVisible();
    await manualRow.getByRole("button", { name: "Use" }).click();
    await expect(manualRow.getByRole("button", { name: "Active" })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await window.jasmine.listRemoteConnections()).find((connection) => connection.name === "WSL project")?.active)).toBe(true);

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator(".remote-meter")).toHaveText("WSL project");
    await page.locator(".rich-composer-editor").fill("remote coding check");
    await page.locator(".send-button").click();
    await expect(page.locator(".assistant-block").last()).toContainText("Remote coding target: WSL project");
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

    await textarea.fill("use skill for this answer");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Inline skill reply using technical-writer.");
    await expect(page.locator(".user-bubble").last().getByLabel("Inline skills")).toContainText("technical-writer");
    await page.getByRole("button", { name: "Open Context taxonomy" }).click();
    const inlinePromptTaxonomy = page.locator(".taxonomy-item", { hasText: "Current user prompt" }).last();
    await expect(inlinePromptTaxonomy).toContainText("Explicit User Selected Skills");
    await expect(inlinePromptTaxonomy).toContainText("When this skill is active");
    await page.getByRole("button", { name: "Close Context taxonomy tab" }).click();
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

    await page.getByRole("button", { name: "Close settings" }).click();
    const textarea = page.locator(".rich-composer-editor");
    await textarea.fill("$jasmine");
    await expect(page.locator(".skill-command-menu")).toBeVisible();
    await expect(page.locator(".skill-command-menu")).toContainText("$jasmine-e2e");
    await page.locator(".skill-command-menu").getByRole("option", { name: /jasmine-e2e/ }).click();
    await expect(page.locator(".inline-skill-row")).toContainText("jasmine-e2e");
    await expectComposerEditorText(textarea, "");
    await page.locator(".inline-skill-row").getByRole("button", { name: /jasmine-e2e/ }).click();
    await expect(page.locator(".inline-skill-row")).toHaveCount(0);

    await openSettings(page, "Packages");
    await row.getByRole("switch", { name: /Disable jasmine-e2e-plugin/ }).click();
    await expect(row).toContainText("Disabled");

    await page.getByRole("button", { name: "Close settings" }).click();
    await textarea.fill("@jasmine");
    await expect(page.locator(".mention-menu")).toBeVisible();
    await expect(page.locator(".mention-menu")).toContainText("Packages");
    await expect(page.locator(".mention-row", { hasText: "@jasmine-e2e-plugin" })).toContainText("Activate this package for this chat");
    await expect(page.locator(".mention-row", { hasText: "@jasmine-e2e-plugin" })).toBeVisible();
    await page.locator(".mention-row", { hasText: "@jasmine-e2e-plugin" }).click();
    await expect(page.locator(".inline-plugin-row")).toContainText("jasmine-e2e-plugin");
    await expectComposerEditorText(textarea, "");
    await textarea.fill("use temporary plugin package");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".inline-plugin-row")).toContainText("jasmine-e2e-plugin");
    await expect(page.locator(".user-bubble").last().getByLabel("Active packages")).toContainText("jasmine-e2e-plugin");
    await expect(page.locator(".assistant-block").last().getByLabel("Packages used")).toContainText("jasmine-e2e-plugin");
    await textarea.fill("continue with active plugin package");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".assistant-block").last()).toContainText("Mock reply from Jasmine.");
    await expect(page.locator(".user-bubble").last().getByLabel("Active packages")).toContainText("jasmine-e2e-plugin");
    await expect(page.locator(".assistant-block").last().getByLabel("Packages used")).toContainText("jasmine-e2e-plugin");
    await page.locator(".inline-plugin-row").getByRole("button", { name: /jasmine-e2e-plugin/ }).click();
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
