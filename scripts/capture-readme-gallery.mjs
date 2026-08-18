import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";
import { configureRealDeepSeek, readmeLaunchOptions, verifyCapturedVersion } from "./lib/readmeCapture.mjs";

const rootDir = process.cwd();
const outputDir = path.join(rootDir, "docs", "assets", "screenshots");
const userDataDir = path.join(rootDir, ".tmp", "readme-gallery");
const demoProjectDir = path.join(userDataDir, "Jasmine Demo Workspace");

await rm(outputDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await mkdir(path.join(demoProjectDir, "src"), { recursive: true });
await writeFile(path.join(demoProjectDir, "AGENTS.md"), "# Demo workspace\n\nFollow exact file-edit requests and keep final summaries concise.\n", "utf8");
await writeFile(path.join(demoProjectDir, "src", "overview.md"), "# Product overview\n\nJasmine is an independent desktop GUI for the Pi coding agent.\n", "utf8");
await writeFile(path.join(demoProjectDir, "src", "release-checklist.md"), "# Release checklist\n\n- Draft\n", "utf8");

if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required for the real-model README gallery.");

const app = await electron.launch(readmeLaunchOptions({ rootDir, userDataDir, demoProjectDir }));

let page;
let appVersion;
let providerCheck;
const captured = [];
try {
  page = await app.firstWindow();
  await page.locator(".app-shell").waitFor({ timeout: 20_000 });
  appVersion = await verifyCapturedVersion(app);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
  });
  await page.locator(".project-row", { hasText: "Jasmine Demo Workspace" }).waitFor();
  await page.addStyleTag({ content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}" });
  await page.evaluate(async () => {
    await Promise.all([
      window.jasmine.createMemory({ content: "Prefer concise answers with concrete next steps." }),
      window.jasmine.createManualActivityObservation({ note: "Prepared the Jasmine open-source walkthrough." }),
      window.jasmine.updateAppSettings({ permissionMode: "full-access" })
    ]);
  });
  providerCheck = await configureRealDeepSeek(page);
  await page.reload();
  await page.locator(".app-shell").waitFor({ timeout: 20_000 });
  await page.addStyleTag({ content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}" });

  const projectRow = page.locator(".project-row", { hasText: "Jasmine Demo Workspace" }).first();
  await projectRow.locator(".project-item").click();
  await page.locator(".empty-state").waitFor();
  await sendMessage("Update src/release-checklist.md with a polished three-item checklist covering tests, documentation, and packaging. Use the file tools, then confirm the result in one sentence.");
  await page.evaluate(async () => {
    const threads = await window.jasmine.listThreads();
    const target = threads
      .filter((thread) => thread.messageCount >= 2)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!target) throw new Error("Captured README thread is unavailable.");
    await window.jasmine.renameThread({ id: target.id, title: "Release readiness checklist" });
  });
  await page.reload();
  await page.locator(".assistant-block").waitFor({ timeout: 20_000 });
  await page.addStyleTag({ content: "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}" });
  await capture("main");

  await page.getByRole("button", { name: "Open Artifacts" }).click();
  await capture("artifacts");
  await page.getByRole("button", { name: "Open Terminal" }).click();
  await page.locator(".terminal-output").waitFor();
  await capture("terminal");
  for (const label of ["Close Terminal tab", "Close Artifacts tab"]) {
    const close = page.getByRole("button", { name: label, exact: true });
    if (await close.count()) await close.click();
  }

  await page.getByRole("button", { name: "Working" }).click();
  await page.locator(".working-page").waitFor();
  await capture("working");
  await projectRow.locator(".project-item").click();

  await page.locator(".side-top").getByRole("button", { name: "Search" }).click();
  await page.getByPlaceholder("Search chats").fill("release");
  await page.waitForTimeout(250);
  await capture("search");
  await page.keyboard.press("Escape");

  await openCommandPage("Memory", ".memory-panel");
  await page.getByRole("button", { name: "Refresh memories" }).click();
  await page.locator(".memory-row").waitFor();
  await capture("memory");
  await page.getByRole("button", { name: "Close memory panel" }).click();

  await openCommandPage("Activity", ".activity-panel");
  await page.getByRole("button", { name: "Refresh activity" }).click();
  await page.locator(".activity-row").waitFor();
  await capture("activity");
  await page.getByRole("button", { name: "Close activity panel" }).click();

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.locator(".side-menu").getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-nav").waitFor();
  for (const [label, filename] of [
    ["General", "settings-general"],
    ["Providers", "settings-providers"],
    ["Appearance", "settings-appearance"],
    ["Memory", "settings-memory"],
    ["Skills", "settings-skills"],
    ["Packages", "settings-packages"],
    ["Prompt Templates", "settings-prompt-templates"],
    ["Activity", "settings-activity"],
    ["About", "settings-about"]
  ]) {
    await page.locator(".settings-nav").getByRole("button", { name: label, exact: true }).click();
    await capture(filename);
  }
} finally {
  await app.close().catch(() => undefined);
}

console.log(`Captured ${captured.length} README screenshots with Jasmine ${appVersion} and real ${providerCheck.model}:\n${captured.join("\n")}`);

async function capture(name) {
  await page.waitForTimeout(180);
  await sanitizeVisiblePaths();
  const filePath = path.join(outputDir, `${name}.png`);
  await page.screenshot({ path: filePath });
  captured.push(path.relative(rootDir, filePath));
}

async function sanitizeVisiblePaths() {
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent || !/[A-Za-z]:\\/.test(node.textContent)) continue;
      node.textContent = node.textContent
        .replace(/[A-Za-z]:\\Users\\Administrator\\[^\n]*/g, "C:\\Workspace\\Jasmine Demo Workspace")
        .replace(/[A-Za-z]:\\[^\n]*/g, "C:\\Workspace\\Jasmine Demo Workspace");
    }
  });
}

async function sendMessage(text) {
  const assistantBlocks = page.locator(".assistant-block");
  const previousCount = await assistantBlocks.count();
  const composer = page.locator(".rich-composer-editor");
  await composer.fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await assistantBlocks.nth(previousCount).waitFor({ timeout: 180_000 });
  await page.waitForFunction(() => !document.querySelector(".assistant-block.live-message"), undefined, { timeout: 180_000 });
}

async function openCommandPage(label, selector) {
  await page.keyboard.press("Control+K");
  await page.locator(".command-panel").waitFor();
  await page.locator(".command-panel").getByRole("button", { name: label }).click();
  await page.locator(selector).waitFor();
}
