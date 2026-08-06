import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRedSquare, ensureDirectory, escapeHtml, launchHarnessApp, resetDirectory, rootDir } from "./lib/uiHarness.mjs";

const outputRoot = path.join(rootDir, "test-results", "ui-harness", "visual");
const outputDir = path.join(outputRoot, "screenshots");
const userDataDir = path.join(rootDir, ".tmp", "harness-visual");
const matrixPath = path.join(outputRoot, "visual-matrix.html");
const captures = [];

await resetDirectory(userDataDir);
await ensureDirectory(outputDir);
const redSquarePath = await createRedSquare(userDataDir);
const skillRootPath = await createExternalSkillFixture(userDataDir);
const sshConfigPath = await createSshConfigFixture(userDataDir);
const promptTemplateRootPath = await createPromptTemplateFixture(userDataDir);

const app = await launchHarnessApp({
  userDataDir,
  env: {
    JASMINE_E2E_MOCK_AI: "1",
    JASMINE_E2E_MANY_MODELS: "1",
    JASMINE_E2E_PICK_FILE: redSquarePath,
    JASMINE_E2E_PICK_SKILL_FOLDERS: skillRootPath,
    JASMINE_E2E_PICK_PROMPT_TEMPLATE_PATHS: promptTemplateRootPath,
    JASMINE_E2E_SSH_CONFIG_FILE: sshConfigPath
  }
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell");
  await capture(page, "01-active-chat", "Seeded active chat with assistant message");

  await page.getByRole("button", { name: "New chat" }).first().click();
  await page.waitForSelector(".empty-state");
  await capture(page, "02-empty-chat", "Centered empty chat state");
  await page.getByRole("button", { name: "Open Terminal" }).click();
  await page.waitForSelector(".chat-right-panel .terminal-output");
  await capture(page, "02-empty-chat-right-panel", "Empty chat remains clear of the right-side Terminal panel");
  await closeAllRightPanelTabs(page);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1500, 900);
  });
  await page.locator(".model-pill").click();
  await page.waitForSelector(".model-menu");
  await capture(page, "03-empty-max-model-menu", "Empty-chat model menu remains anchored in a large window");
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1200, 800);
  });

  await page.locator(".model-pill").click();
  await page.waitForSelector(".model-menu");
  await capture(page, "03-model-menu", "Codex-like compact model menu");
  await page.keyboard.press("Escape");

  await page.evaluate(async () => {
    await window.jasmine.fetchProviderModels("moonshot");
  });
  await page.reload();
  await page.waitForSelector(".app-shell");
  await page.locator(".model-pill").click();
  await page.waitForSelector(".model-menu");
  await capture(page, "03-long-model-menu", "Long model menu stays bounded and scrollable");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Clear History..." }).click();
  await page.waitForSelector(".confirm-dialog");
  await capture(page, "03-clear-history-confirm", "App-styled destructive confirmation dialog");
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "New chat" }).first().click();
  await fillComposer(page, "Visual matrix draft");
  await page.waitForTimeout(350);
  await page.getByRole("button", { name: "New chat" }).first().click();
  await page.locator(".thread-row", { hasText: "draft" }).first().hover();
  await capture(page, "03-thread-lifecycle", "Sidebar draft row with rename and delete actions");
  await page.evaluate(async () => {
    for (let index = 0; index < 65; index += 1) {
      const thread = await window.jasmine.createThread({ title: `Visual settings access ${index + 1}` });
      await window.jasmine.updateThreadDraft({ threadId: thread.id, content: `visual draft ${index + 1}` });
    }
  });
  await page.reload();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.waitForSelector(".side-menu");
  await capture(page, "03-sidebar-more-menu", "Fixed sidebar More menu remains reachable with many chats");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "New chat" }).first().click();
  await sendComposerMessage(page, "return markdown sample");
  await page.waitForSelector(".markdown-message table");
  await capture(page, "04-markdown-message", "Markdown message with table, link, and code copy action");
  await page.getByRole("button", { name: "New chat" }).first().click();
  await sendComposerMessage(page, "show write timeline");
  await page.waitForSelector(".message-timeline .tool-run-item");
  await capture(page, "04-agent-timeline", "Assistant chronological timeline with compact tool run summary and output");
  await sendComposerMessage(page, "show edit timeline");
  await page.waitForSelector(".message-jump-rail");
  await page.getByRole("button", { name: "Open user message navigation" }).click();
  await page.waitForTimeout(180);
  await capture(page, "04-message-jump-rail", "Clickable user message jump pane next to the right rail");
  await page.getByRole("button", { name: "Open Terminal" }).click();
  await page.waitForSelector(".chat-right-panel .terminal-output");
  await page.getByLabel("Terminal command").click();
  await page.keyboard.type("echo JASMINE_VISUAL_TERMINAL");
  await page.keyboard.press("Enter");
  await page.locator(".terminal-output").waitFor({ state: "visible" });
  await page.waitForTimeout(900);
  await capture(page, "04-right-panel-terminal", "Right-side Terminal panel with live shell output");
  await page.getByRole("button", { name: "Add panel" }).click();
  await page.waitForSelector(".right-panel-add-menu");
  await capture(page, "04-right-panel-add-menu", "Right-panel add chooser offers another Terminal and unopened singleton types");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Collapse panel" }).click();
  await page.waitForSelector(".chat-right-panel", { state: "hidden" });
  await capture(page, "04-right-panel-collapsed", "Collapsed right panel restores the main chat width while keeping the rail state");
  await page.getByRole("button", { name: "Open Terminal" }).click();
  await page.waitForSelector(".chat-right-panel .terminal-output");
  await capture(page, "04-right-panel-restored-terminal", "Restored Terminal panel keeps prior shell output after collapse");
  await page.getByRole("button", { name: "Open Artifacts" }).click();
  await page.waitForSelector(".chat-right-panel");
  await capture(page, "04-right-panel-artifacts", "Right-side Artifacts panel for chat-produced files and web artifacts");
  await sendComposerMessage(page, "show structured taxonomy");
  await page.getByRole("button", { name: "Open Context taxonomy" }).click();
  await page.waitForSelector(".taxonomy-item");
  const systemTaxonomy = page.locator(".taxonomy-item", { hasText: "System prompt" }).first();
  if (await systemTaxonomy.count()) {
    await systemTaxonomy.locator(".taxonomy-item-details > summary").click();
  }
  const projectSegment = page.locator(".taxonomy-segment", { hasText: "Project context" });
  if (await projectSegment.count()) {
    await projectSegment.locator("summary").click();
  }
  await capture(page, "04-right-panel-context", "Right-side Context taxonomy panel with expandable provider payload pieces");
  await closeAllRightPanelTabs(page);
  await page.locator(".assistant-block").last().getByRole("button", { name: "Message actions" }).click();
  await page.waitForSelector(".message-menu");
  await capture(page, "04-message-actions-menu", "Assistant message action menu");
  await page.locator(".message-menu").getByRole("button", { name: "Remember this" }).click();
  await page.waitForSelector(".memory-dialog");
  await capture(page, "05-memory-confirm", "Explicit memory confirmation dialog");
  await page.getByRole("textbox", { name: "Memory content" }).fill("Remember that Jasmine visual review prefers compact dense controls.");
  await page.locator(".memory-dialog").getByRole("button", { name: "Save memory" }).click();
  await page.waitForSelector(".memory-panel");
  await capture(page, "05-memory-panel", "Memory panel with saved local memory");
  await page.locator(".memory-panel").getByRole("button", { name: "Close memory panel" }).click();

  await page.keyboard.press("Control+K");
  await page.waitForSelector(".command-panel");
  await page.locator(".command-panel").getByRole("button", { name: "Activity" }).click();
  await page.waitForSelector(".activity-panel");
  await page.locator(".activity-controls").getByRole("button", { name: "Enable recorder" }).click();
  await page.locator(".activity-create textarea").fill("Reviewed Jasmine visual matrix for Activity Recorder shell.");
  await page.locator(".activity-create").getByRole("button", { name: "Add observation" }).click();
  await page.waitForSelector(".activity-row");
  await capture(page, "06-activity-panel", "Activity Recorder shell with visible status and manual observation");
  await page.locator(".activity-panel").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await capture(page, "06-activity-observation", "Activity manual observation list and search");
  await page.locator(".activity-panel").getByRole("button", { name: "Close activity panel" }).click();

  await page.keyboard.press("Control+K");
  await page.waitForSelector(".command-panel");
  await capture(page, "07-command-palette", "Compact command palette with major surface commands");
  await page.locator(".command-panel").getByRole("button", { name: "UI catalog" }).click();
  await page.waitForSelector(".ui-catalog");
  await capture(page, "08-ui-catalog", "Jasmine design system primitive catalog");
  await page.locator(".ui-catalog").getByRole("button", { name: "Close" }).click();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.locator(".side-menu").getByRole("button", { name: "Settings" }).click();
  await page.waitForSelector(".settings-panel");
  const languageSelect = page.locator(".settings-detail select").first();
  if (await languageSelect.inputValue() !== "en") {
    await languageSelect.selectOption("en");
    await page.locator(".settings-detail button.primary").click();
    await page.waitForFunction(() => document.querySelector(".settings-nav")?.textContent?.includes("General"));
  }
  await capture(page, "07-settings-general", "Settings General page with single navigation");
  await languageSelect.selectOption("zh");
  await page.locator(".settings-detail button.primary").click();
  await page.waitForFunction(() => document.querySelector(".settings-nav")?.textContent?.includes("通用"));
  await capture(page, "07-settings-general-zh", "Settings General page in Chinese");
  await page.locator(".settings-nav").getByRole("button", { name: "服务商" }).click();
  await capture(page, "07-settings-provider-zh", "Provider second-level settings in Chinese");
  await page.locator(".settings-nav").getByRole("button", { name: "通用" }).click();
  await languageSelect.selectOption("en");
  await page.locator(".settings-detail button.primary").click();
  await page.waitForFunction(() => document.querySelector(".settings-nav")?.textContent?.includes("General"));
  await page.locator(".settings-nav").getByRole("button", { name: "Appearance" }).click();
  await capture(page, "07-settings-appearance", "Settings Appearance theme controls and live preview");
  await page.locator(".settings-nav").getByRole("button", { name: "Skills" }).click();
  await page.getByRole("button", { name: "Add Folder" }).click();
  await page.waitForSelector(".skill-settings-row");
  await capture(page, "07-settings-skills", "Settings Skills compact grouped management list");
  await page.locator(".settings-nav").getByRole("button", { name: "Chrome Control" }).click();
  await capture(page, "07-settings-chrome-control", "Settings Chrome Control takeover setup and status");
  await page.locator(".settings-nav").getByRole("button", { name: "Prompt Templates" }).click();
  await page.getByRole("button", { name: "Add Source" }).click();
  await page.waitForSelector(".prompt-template-row");
  await capture(page, "07-settings-prompts", "Settings Prompt Templates compact source and slash-command list");
  await page.locator(".settings-nav").getByRole("button", { name: "MCP Servers" }).click();
  await page.waitForSelector(".mcp-card");
  await capture(page, "07-settings-mcp", "Settings MCP marketplace with installable server cards");
  await page.locator(".settings-nav").getByRole("button", { name: "Remote" }).click();
  await page.getByRole("button", { name: "Import from SSH Config" }).click();
  await page.waitForSelector(".remote-row");
  await capture(page, "07-settings-remote", "Settings Remote Connections with imported SSH host");
  await page.locator(".settings-nav").getByRole("button", { name: "Memory" }).click();
  await capture(page, "07-settings-memory", "Settings Memory page");
  await page.locator(".settings-nav").getByRole("button", { name: "Activity" }).click();
  await capture(page, "07-settings-activity", "Settings Activity page");
  await page.locator(".settings-nav").getByRole("button", { name: "About" }).click();
  await capture(page, "07-settings-about", "Settings About page");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1500, 900);
  });
  await capture(page, "07-settings-maximized", "Settings detail remains balanced in a large window");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1200, 800);
  });
  await page.getByRole("button", { name: "Close settings" }).click();
  await fillComposer(page, "@");
  await page.waitForSelector(".mention-menu");
  await capture(page, "02-mention-menu", "Composer @ menu with remote target and file groups");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.locator(".side-menu").getByRole("button", { name: "Settings" }).click();
  await page.waitForSelector(".settings-panel");
  await page.locator(".settings-nav").getByRole("button", { name: "Providers" }).click();
  await capture(page, "04-settings-deepseek", "Provider settings DeepSeek variant");

  await page.locator(".settings-subnav").getByRole("button", { name: /Moonshot Kimi/ }).click();
  await page.waitForTimeout(120);
  await capture(page, "05-settings-kimi", "Provider settings Kimi variant");

  await page.getByRole("button", { name: "Close settings" }).click();
  await page.evaluate(async () => {
    const provider = (await window.jasmine.listProviders())[0];
    await window.jasmine.updateProviderModel({
      providerId: provider.id,
      modelId: provider.defaultModel,
      enabled: true,
      capabilities: { vision: true }
    });
  });
  await page.getByRole("button", { name: "Attach file" }).click();
  await page.waitForSelector(".attachment-row img");
  await page.getByRole("button", { name: "Preview attachment red-square.png" }).click();
  await page.waitForSelector(".image-lightbox");
  await capture(page, "06-image-lightbox", "Image attachment lightbox");

  await writeMatrix();
} finally {
  await app.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}

async function capture(page, name, title) {
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(outputDir, filename), fullPage: true });
  captures.push({ name, title, file: `screenshots/${filename}` });
}

async function writeMatrix() {
  const cards = captures.map((capture) => `<figure>
      <img src="${capture.file}" alt="${escapeHtml(capture.title)}" />
      <figcaption><b>${capture.name}</b><span>${escapeHtml(capture.title)}</span></figcaption>
    </figure>`).join("\n\n");

  await writeFile(matrixPath, `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Jasmine Harness Visual Matrix</title>
  <style>
    body { margin: 0; padding: 24px; background: #f6f6f6; color: #0d0d0d; font-family: Inter, system-ui, sans-serif; }
    header { margin: 0 0 18px; }
    h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: 0; }
    p { margin: 0; color: #666; }
    main { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    figure { margin: 0; border: 1px solid #ddd; border-radius: 8px; background: #fff; overflow: hidden; box-shadow: 0 12px 30px rgba(13, 13, 13, 0.07); }
    img { display: block; width: 100%; background: #fff; }
    figcaption { display: grid; gap: 3px; padding: 10px 12px; border-top: 1px solid #eee; font-size: 13px; }
    figcaption span { color: #666; }
  </style>
</head>
<body>
  <header>
    <h1>Jasmine Harness Visual Matrix</h1>
    <p>Generated by <code>npm run harness:visual</code>. Inspect this before closing material UI changes.</p>
  </header>
  <main>${cards}</main>
</body>
</html>
`, "utf8");
}

async function closeAllRightPanelTabs(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const panel = page.locator(".chat-right-panel");
    if (await panel.count() === 0) return;
    const activeClose = page.locator(".right-panel-tab.active").getByRole("button", { name: /Close .* tab/ });
    if (await activeClose.count() === 0) return;
    await activeClose.click();
    await page.waitForTimeout(80);
  }
}

async function sendComposerMessage(page, text) {
  await fillComposer(page, text);
  await waitForComposerReady(page);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForSelector(".assistant-block");
  await page.waitForFunction(() => {
    const meter = document.querySelector(".run-meter");
    const send = Array.from(document.querySelectorAll("button.send-button"))
      .find((button) => button.getAttribute("aria-label") === "Send");
    const text = meter?.textContent ?? "";
    return send instanceof HTMLButtonElement && !text.includes("running") && !text.includes("stopping");
  });
}

async function fillComposer(page, text) {
  await page.locator(".rich-composer-editor").fill(text);
  await waitForComposerReady(page);
}

async function waitForComposerReady(page) {
  await page.waitForFunction(() => {
    const editor = document.querySelector(".rich-composer-editor");
    const send = Array.from(document.querySelectorAll("button.send-button"))
      .find((button) => button.getAttribute("aria-label") === "Send");
    const value = editor instanceof HTMLElement ? (editor.innerText || editor.textContent || "").trim() : "";
    return value.length > 0 && send instanceof HTMLButtonElement && !send.disabled;
  });
}

async function createExternalSkillFixture(baseDir) {
  const root = path.join(baseDir, "custom-skills");
  const valid = path.join(root, "ui-ux-product-harness");
  await mkdir(valid, { recursive: true });
  await writeFile(path.join(valid, "SKILL.md"), [
    "---",
    "name: ui-ux-product-harness",
    "description: Build or run a productized UI/UX self-testing harness.",
    "---",
    "",
    "# UI/UX Product Harness",
    "",
    "Use this external skill from a custom path."
  ].join("\n"));
  return root;
}

async function createSshConfigFixture(baseDir) {
  const sshDir = path.join(baseDir, "ssh");
  const configPath = path.join(sshDir, "config");
  await mkdir(sshDir, { recursive: true });
  await writeFile(configPath, [
    "Host visual-dev",
    "  HostName 127.0.0.1",
    "  User dev",
    "  Port 2222",
    "",
    "Host *",
    "  ForwardAgent yes",
    ""
  ].join("\n"));
  return configPath;
}

async function createPromptTemplateFixture(baseDir) {
  const root = path.join(baseDir, "prompt-templates");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "triage.md"), [
    "---",
    "description: Triage an issue quickly",
    "argument-hint: <issue>",
    "---",
    "",
    "Triage $ARGUMENTS with likely cause, impact, and next action."
  ].join("\n"));
  return root;
}
