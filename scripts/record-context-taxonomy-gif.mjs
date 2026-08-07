import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";

const rootDir = process.cwd();
const workDir = path.join(rootDir, "test-results", "readme-taxonomy");
const framesDir = path.join(workDir, "frames");
const userDataDir = path.join(rootDir, ".tmp", "readme-taxonomy-real");
const demoProjectDir = path.join(userDataDir, "Jasmine Demo Workspace");
const outputPath = path.join(rootDir, "docs", "assets", "context-taxonomy.gif");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required for the real-model taxonomy demo.");

await rm(workDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true });
await mkdir(path.join(demoProjectDir, "src"), { recursive: true });
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(path.join(demoProjectDir, "AGENTS.md"), "# Demo workspace\n\nKeep answers concise and avoid tool calls unless necessary.\n", "utf8");
await writeFile(path.join(demoProjectDir, "src", "context.md"), "# Context\n\nJasmine makes assembled model context inspectable.\n", "utf8");

const app = await electron.launch({
  executablePath: path.join(rootDir, "node_modules", "electron", "dist", "electron.exe"),
  args: [".", "--disable-gpu"],
  cwd: rootDir,
  env: {
    ...process.env,
    JASMINE_E2E_HARNESS: "1",
    JASMINE_E2E_OFFSCREEN: "1",
    JASMINE_E2E_USER_DATA_DIR: userDataDir,
    JASMINE_DEFAULT_PROJECT_ROOT: demoProjectDir
  }
});

let page;
let frameCount = 0;
let recording = false;
try {
  page = await app.firstWindow();
  await page.locator(".app-shell").waitFor({ timeout: 20_000 });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
  });
  await page.evaluate(() => window.localStorage.setItem("jasmine.reasoningEffort", "xhigh"));
  await page.reload();
  await page.locator(".app-shell").waitFor({ timeout: 20_000 });
  const projectRow = page.locator(".project-row", { hasText: "Jasmine Demo Workspace" }).first();
  await projectRow.waitFor();
  await projectRow.locator(".project-item").click();

  const providerCheck = await page.evaluate(async () => {
    const providers = await window.jasmine.listProviders();
    const deepseek = providers.find((provider) => provider.id === "deepseek");
    if (!deepseek) throw new Error("DeepSeek provider is missing");
    const result = await window.jasmine.testProvider(deepseek.id);
    return { model: deepseek.defaultModel, status: result.status };
  });
  if (providerCheck.status !== "connected") throw new Error(`DeepSeek provider test returned ${providerCheck.status}`);

  const replies = [];
  replies.push(await sendRealMessage("In one short sentence, explain why inspectable context improves an AI assistant."));
  replies.push(await sendRealMessage("Now give exactly two practical ways a user can verify the context used for this reply."));
  await mkdir(path.join(rootDir, "docs", "assets", "screenshots"), { recursive: true });
  await page.screenshot({ path: path.join(rootDir, "docs", "assets", "screenshots", "main.png") });

  recording = true;
  const capturePromise = captureFrames();
  await page.waitForTimeout(1_600);
  await page.getByRole("button", { name: "Open Context taxonomy" }).click();
  await page.getByRole("complementary", { name: "Context taxonomy" }).waitFor();
  await page.locator(".taxonomy-summary", { hasText: "provider-payload" }).waitFor({ timeout: 20_000 });
  await page.evaluate(() => {
    const chat = document.querySelector(".chat-page");
    if (chat instanceof HTMLElement) {
      chat.style.setProperty("--right-panel-width", "660px");
      chat.style.setProperty("--right-panel-reserved-width", "692px");
    }
  });
  await page.waitForTimeout(2_400);

  const historyGroup = page.locator(".taxonomy-kind-group", { hasText: "Conversation history" }).first();
  await smoothCenter(historyGroup);
  const historyDetails = historyGroup.locator(".taxonomy-item-details");
  for (let index = 0; index < Math.min(2, await historyDetails.count()); index += 1) {
    await ensureOpen(historyDetails.nth(index));
  }
  await page.waitForTimeout(2_600);

  const currentGroup = page.locator(".taxonomy-kind-group", { hasText: "Current prompt" }).first();
  await smoothCenter(currentGroup);
  await page.waitForTimeout(2_600);

  const optionsGroup = page.locator(".taxonomy-kind-group", { hasText: "Provider options" }).first();
  await smoothCenter(optionsGroup);
  const optionsItem = optionsGroup.locator(".taxonomy-item", { hasText: "Request options" }).first();
  await ensureOpen(optionsItem.locator(".taxonomy-item-details"));
  const reasoning = optionsItem.locator(".taxonomy-segment", { hasText: "Reasoning effort" }).first();
  const other = optionsItem.locator(".taxonomy-segment", { hasText: "Other provider options" }).first();
  await ensureOpen(reasoning);
  await ensureOpen(other);
  const optionText = await optionsItem.innerText();
  if (!optionText.includes('"reasoning_effort": "max"')) throw new Error("Captured payload does not show reasoning_effort=max.");
  if (!optionText.includes('"thinking"') || !optionText.includes('"enabled"')) throw new Error("Captured payload does not show thinking=enabled.");
  await smoothCenter(reasoning);
  await page.waitForTimeout(2_700);
  await smoothCenter(other);
  await page.waitForTimeout(3_000);
  recording = false;
  await capturePromise;

  console.log(JSON.stringify({ provider: "DeepSeek", model: providerCheck.model, turns: replies.map((text) => text.length), frameCount }, null, 2));
} finally {
  recording = false;
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
}

async function smoothCenter(locator) {
  await locator.evaluate((element) => element.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(1_000);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
