import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { configureRealDeepSeek, readmeLaunchOptions, sanitizeCapturePage, verifyCapturedVersion } from "./lib/readmeCapture.mjs";

const rootDir = process.cwd();
const workDir = path.join(rootDir, "test-results", "readme-taxonomy");
const framesDir = path.join(workDir, "frames");
const userDataDir = path.join(rootDir, ".tmp", "readme-taxonomy-real");
const demoProjectDir = path.join(os.tmpdir(), "jasmine-readme-taxonomy", "Jasmine Demo Workspace");
const outputPath = path.join(rootDir, "docs", "assets", "context-taxonomy.gif");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required for the real-model taxonomy demo.");

await rm(workDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
await rm(demoProjectDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true });
await mkdir(path.join(demoProjectDir, "src"), { recursive: true });
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(path.join(demoProjectDir, "AGENTS.md"), "# Demo workspace\n\nKeep answers concise and avoid tool calls unless necessary.\n", "utf8");
await writeFile(path.join(demoProjectDir, "src", "context.md"), "# Context\n\nJasmine makes assembled model context inspectable.\n", "utf8");

const app = await electron.launch(readmeLaunchOptions({ rootDir, userDataDir, demoProjectDir }));

let page;
let frameCount = 0;
let recording = false;
let capturePromise = Promise.resolve();
let appVersion;
try {
  page = await app.firstWindow();
  await page.locator(".app-shell").waitFor({ timeout: 20_000 });
  appVersion = await verifyCapturedVersion(app);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
  });
  await page.evaluate(() => window.localStorage.setItem("jasmine.reasoningEffort", "high"));
  await page.reload();
  await page.locator(".app-shell").waitFor({ timeout: 20_000 });
  const providerCheck = await configureRealDeepSeek(page);
  await page.reload();
  await page.locator(".app-shell").waitFor({ timeout: 20_000 });
  const selectedModelLabel = await page.locator(".model-pill").innerText();
  if (!selectedModelLabel.includes(providerCheck.model)) {
    throw new Error(`Renderer selected ${selectedModelLabel}, expected ${providerCheck.model}.`);
  }
  const projectRow = page.locator(".project-row", { hasText: "Jasmine Demo Workspace" }).first();
  await projectRow.waitFor();
  await projectRow.locator(".project-item").click();
  await page.getByRole("button", { name: "Open Context taxonomy" }).click();
  await page.getByRole("complementary", { name: "Context taxonomy" }).waitFor();

  const replies = [];
  replies.push(await sendRealMessage("In one short sentence, explain why inspectable context improves an AI assistant."));
  replies.push(await sendRealMessage("Now give exactly two practical ways a user can verify the context used for this reply."));
  await page.locator(".taxonomy-view").waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Close Context taxonomy tab" }).click();

  await sanitizeCapturePage(page, { rootDir, demoProjectDir });
  await page.getByRole("button", { name: "Open Context taxonomy" }).click();
  const taxonomyPanel = page.getByRole("complementary", { name: "Context taxonomy" });
  await taxonomyPanel.waitFor();
  await page.locator(".taxonomy-view").waitFor({ timeout: 20_000 });
  await sanitizeCapturePage(page, { rootDir, demoProjectDir });
  recording = true;
  capturePromise = captureFrames();
  await page.evaluate(() => {
    const chat = document.querySelector(".chat-page");
    if (chat instanceof HTMLElement) {
      chat.style.setProperty("--right-panel-width", "660px");
      chat.style.setProperty("--right-panel-reserved-width", "692px");
    }
  });
  await page.waitForTimeout(2_400);

  const historyGroup = page.locator(".taxonomy-group").filter({ has: page.locator(".taxonomy-group-name", { hasText: "Conversation" }) }).first();
  await smoothCenter(historyGroup);
  const historyDetails = historyGroup.locator(".taxonomy-item");
  for (let index = 0; index < Math.min(2, await historyDetails.count()); index += 1) {
    await ensureOpen(historyDetails.nth(index));
  }
  await page.waitForTimeout(2_600);

  const currentGroup = page.locator(".taxonomy-group").filter({ has: page.locator(".taxonomy-group-name", { hasText: "Current prompt" }) }).first();
  await smoothCenter(currentGroup);
  await page.waitForTimeout(2_600);

  const optionsGroup = page.locator(".taxonomy-group").filter({ has: page.locator(".taxonomy-group-name", { hasText: "Request options" }) }).first();
  await smoothCenter(optionsGroup);
  const optionsItem = optionsGroup.locator(".taxonomy-item", { hasText: "Request options" }).first();
  await ensureOpen(optionsItem);
  const reasoning = optionsItem.locator(".taxonomy-part").filter({ hasText: /reasoning_effort|Reasoning effort/i }).first();
  const thinking = optionsItem.locator(".taxonomy-part").filter({ hasText: /Option: thinking|Other provider options/i }).first();
  if (await reasoning.count()) await ensureOpen(reasoning);
  if (await thinking.count()) await ensureOpen(thinking);
  const optionText = await optionsItem.innerText();
  if (!/reasoning_effort[\s\S]{0,80}\bhigh\b/i.test(optionText)) throw new Error("Captured payload does not show reasoning_effort=high.");
  if (!/thinking[\s\S]{0,120}\benabled\b/i.test(optionText)) throw new Error("Captured payload does not show thinking=enabled.");
  await smoothCenter(await reasoning.count() ? reasoning : optionsItem);
  await page.waitForTimeout(2_700);
  await smoothCenter(await thinking.count() ? thinking : optionsItem);
  await page.waitForTimeout(3_000);
  recording = false;
  await capturePromise;

  console.log(JSON.stringify({ version: appVersion, provider: "DeepSeek", model: providerCheck.model, turns: replies.map((text) => text.length), frameCount }, null, 2));
} finally {
  recording = false;
  await capturePromise.catch(() => undefined);
  await app.close().catch(() => undefined);
}

if (frameCount < 10) throw new Error(`Only captured ${frameCount} frames.`);
await run(ffmpeg, [
  "-y",
  "-framerate", "8",
  "-i", path.join(framesDir, "frame-%05d.png"),
  "-vf", "fps=8,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
  "-loop", "0",
  outputPath
]);

const info = await stat(outputPath);
console.log(`${path.relative(rootDir, outputPath)} ${(info.size / 1024 / 1024).toFixed(2)} MiB`);

async function sendRealMessage(text) {
  const assistantBlocks = page.locator(".assistant-block");
  const previousCount = await assistantBlocks.count();
  const composer = page.locator(".rich-composer-editor");
  await composer.fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  const assistant = assistantBlocks.nth(previousCount);
  await assistant.waitFor({ timeout: 180_000 });
  await page.waitForFunction(() => !document.querySelector(".assistant-block.live-message"), undefined, { timeout: 180_000 });
  const value = (await assistant.innerText()).trim();
  if (!value) throw new Error("Real provider returned an empty assistant reply.");
  return value;
}

async function captureFrames() {
  while (recording) {
    const filename = `frame-${String(frameCount).padStart(5, "0")}.png`;
    await page.screenshot({ path: path.join(framesDir, filename) });
    frameCount += 1;
    await page.waitForTimeout(100);
  }
}

async function ensureOpen(details) {
  if (!(await details.count())) throw new Error("Expected taxonomy details are missing.");
  if ((await details.getAttribute("open")) === null) await details.locator(":scope > summary").click();
  await details.locator(":scope > .taxonomy-item-body, :scope > .taxonomy-part-body").first().waitFor();
}

async function smoothCenter(locator) {
  await locator.evaluate((element) => element.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(1_000);
  await sanitizeCapturePage(page, { rootDir, demoProjectDir });
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
