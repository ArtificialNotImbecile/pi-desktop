import { rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { createRedSquare, ensureDirectory, escapePipe, launchHarnessApp, resetDirectory, rootDir } from "./lib/uiHarness.mjs";

const outputDir = path.join(rootDir, "test-results", "ui-harness", "acceptance");
const userDataDir = path.join(rootDir, ".tmp", "acceptance");
const resultPath = path.join(outputDir, "acceptance-result.json");
const reportPath = path.join(outputDir, "acceptance-report.md");

const steps = [];
let app;
let page;

await resetDirectory(userDataDir);
await ensureDirectory(outputDir);
const redSquarePath = await createRedSquare(userDataDir);

try {
  app = await launchHarnessApp({
    userDataDir,
    env: {
      JASMINE_E2E_OFFSCREEN: "",
      JASMINE_E2E_MOCK_AI: "1",
      JASMINE_E2E_PICK_FILE: redSquarePath,
      DEEPSEEK_API_KEY: "acceptance-mock-key",
      KIMI_API_KEY: "acceptance-mock-key"
    }
  });

  page = await app.firstWindow();
  await page.waitForSelector(".app-shell");
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(1280, 720);
    win?.focus();
  });

  await acceptanceStep("ACCEPT-001", "Launch normal desktop shell", async () => {
    await assertVisible(".app-shell");
    await assertVisible(".chat-page");
    await capture("01-launch-shell");
  });

  await acceptanceStep("ACCEPT-002", "Send first text chat", async () => {
    await startEmptyThread();
    await fillComposer("show timeline tool call");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForText(".assistant-block", "Mock reply from Jasmine.");
    await assertVisible(".thinking-item");
    await assertVisible(".tool-run-item");
    await capture("02-text-chat");
  });

  await acceptanceStep("ACCEPT-003", "Switch provider/model from compact menu", async () => {
    await page.locator(".model-pill").click();
    await assertVisible(".model-menu");
    await capture("03-model-menu-open");
    await page.locator(".model-provider-group", { hasText: "Moonshot Kimi" }).getByRole("button", { name: /kimi-k2\.6/ }).click();
    await waitForText(".model-pill", "kimi-k2.6");
    await startEmptyThread();
    await fillComposer("Acceptance provider switch");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForText(".assistant-block", "Mock reply from Jasmine.");
    await capture("04-kimi-chat");
    const latestAssistant = page.locator(".assistant-block").last();
    await latestAssistant.locator(".message-run-line").filter({ hasText: "kimi-k2.6" }).waitFor({ state: "visible" });
  });

  await acceptanceStep("ACCEPT-004", "Attach image and open lightbox", async () => {
    await page.evaluate(async () => {
      const providers = await window.jasmine.listProviders();
      const kimi = providers.find((provider) => provider.id === "kimi") ?? providers[0];
      await window.jasmine.updateProviderModel({
        providerId: kimi.id,
        modelId: kimi.defaultModel,
        enabled: true,
        capabilities: { vision: true }
      });
    });
    await startEmptyThread();
    await page.getByRole("button", { name: "Attach file" }).click();
    await page.getByRole("button", { name: "Send" }).click();
    await assertVisible(".message-image-grid img");
    await waitForText(".assistant-block", "Mock reply received 1 image attachment.");
    await page.waitForFunction(() => document.querySelectorAll(".assistant-block.live-message").length === 0);
    await page.getByRole("button", { name: "Preview red-square.png" }).click();
    await assertVisible(".image-lightbox");
    await capture("05-image-lightbox");
    await page.getByRole("button", { name: "Close image preview" }).click();
    await assertHidden(".image-lightbox");
  });

  await acceptanceStep("ACCEPT-005", "Edit earlier user message and truncate stale branch", async () => {
    await startEmptyThread();
    await fillComposer("first branch");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForText(".assistant-block", "First branch reply.");
    await fillComposer("second branch");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForText(".assistant-block", "Second branch reply.");
    await page.locator(".user-message-wrap").first().hover();
    await page.locator(".user-message-wrap").first().getByRole("button", { name: "Edit message" }).click();
    await fillComposer("first branch edited");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForText(".user-bubble", "first branch edited");
    await waitForText(".assistant-block", "First branch reply.");
    await page.waitForFunction(() =>
      document.querySelectorAll(".message-stack .user-bubble").length === 1 &&
      document.querySelectorAll(".message-stack .assistant-block").length === 1 &&
      !document.querySelector(".message-stack")?.textContent?.includes("second branch")
    );
    await capture("06-edit-branch");
  });

  await acceptanceStep("ACCEPT-006", "Open provider settings variants and controls", async () => {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.locator(".side-menu").getByRole("button", { name: "Settings" }).click();
    await assertVisible(".settings-panel");
    await page.locator(".settings-nav").getByRole("button", { name: "Providers" }).click();
    await page.locator(".settings-subnav").getByRole("button", { name: /DeepSeek/ }).click();
    await page.locator(".settings-actions").getByRole("button", { name: "Test" }).click();
    await waitForText(".provider-status", "Connected");
    await page.locator(".models-header").getByRole("button", { name: "Fetch" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".model-list .model-row").length >= 2);
    await capture("07-settings-deepseek");
    await page.locator(".settings-subnav").getByRole("button", { name: /Moonshot Kimi/ }).click();
    await page.locator(".settings-actions").getByRole("button", { name: "Test" }).click();
    await waitForText(".provider-status", "Connected");
    await capture("08-settings-kimi");
    await page.getByRole("button", { name: "Close settings" }).click();
    await assertHidden(".settings-panel");
  });

  await writeResults("pass");
} catch (error) {
  await writeResults("fail", error);
  throw error;
} finally {
  await app?.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}

async function acceptanceStep(id, title, run) {
  const startedAt = new Date().toISOString();
  try {
    await run();
    steps.push({ id, title, status: "pass", startedAt, finishedAt: new Date().toISOString() });
  } catch (error) {
    steps.push({
      id,
      title,
      status: "fail",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function startEmptyThread() {
  await page.getByRole("button", { name: "New chat" }).first().click();
  await page.waitForSelector(".empty-state");
}

async function assertVisible(selector) {
  await page.locator(selector).first().waitFor({ state: "visible" });
}

async function assertHidden(selector) {
  await page.locator(selector).first().waitFor({ state: "hidden" });
}

async function waitForText(selector, text) {
  await page.locator(selector).filter({ hasText: text }).last().waitFor({ state: "visible" });
}

async function fillComposer(text) {
  await page.locator(".rich-composer-editor").fill(text);
  await page.waitForFunction(() => {
    const editor = document.querySelector(".rich-composer-editor");
    const send = document.querySelector(".send-button");
    const value = editor instanceof HTMLElement ? (editor.innerText || editor.textContent || "").trim() : "";
    return value.length > 0 && send instanceof HTMLButtonElement && !send.disabled;
  });
}

async function capture(name) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(outputDir, file), fullPage: true });
  steps.push({ id: `SHOT-${name}`, title: `Screenshot ${name}`, status: "evidence", file: `test-results/ui-harness/acceptance/${file}` });
}

async function writeResults(status, error) {
  const result = {
    status,
    generatedAt: new Date().toISOString(),
    runner: "headed-electron-playwright",
    note: "GATE-006 fallback acceptance. Uses a real Electron desktop window with click/type/screenshot evidence when Computer Use native pipe is unavailable.",
    error: error instanceof Error ? error.message : error ? String(error) : undefined,
    steps
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(reportPath, renderReport(result), "utf8");
}

function renderReport(result) {
  const rows = result.steps
    .map((step) => `| ${step.id} | ${step.status} | ${escapePipe(step.title)} | ${step.file ? `\`${step.file}\`` : step.error ? escapePipe(step.error) : ""} |`)
    .join("\n");
  return `# UI Acceptance Report

Status: ${result.status}

Generated at: ${result.generatedAt}

Runner: ${result.runner}

Note: ${result.note}

| ID | Status | Step | Evidence |
| --- | --- | --- | --- |
${rows}
`;
}
