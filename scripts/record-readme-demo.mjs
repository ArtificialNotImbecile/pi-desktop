import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";

const rootDir = process.cwd();
const rawDir = path.join(rootDir, "test-results", "readme-demo", "raw");
const userDataDir = path.join(rootDir, ".tmp", "readme-demo");
const assetDir = path.join(rootDir, "docs", "assets");
const webmPath = path.join(assetDir, "jasmine-context-taxonomy-demo.webm");
const mp4Path = path.join(assetDir, "jasmine-context-taxonomy-demo.mp4");
const gifPath = path.join(assetDir, "jasmine-context-taxonomy-demo.gif");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

await rm(rawDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
await mkdir(rawDir, { recursive: true });
await mkdir(assetDir, { recursive: true });

const app = await electron.launch({
  executablePath: path.join(rootDir, "node_modules", "electron", "dist", "electron.exe"),
  args: [".", "--disable-gpu"],
  cwd: rootDir,
  recordVideo: {
    dir: rawDir,
    size: { width: 1440, height: 900 }
  },
  env: {
    ...process.env,
    JASMINE_E2E_HARNESS: "1",
    JASMINE_E2E_OFFSCREEN: "1",
    JASMINE_E2E_MOCK_AI: "1",
    JASMINE_E2E_MANY_MODELS: "1",
    JASMINE_E2E_USER_DATA_DIR: userDataDir,
    DEEPSEEK_API_KEY: "readme-demo-placeholder",
    KIMI_API_KEY: "readme-demo-placeholder"
  }
});

let page;
let video;
try {
  page = await app.firstWindow();
  video = page.video();
  if (!video) throw new Error("Playwright did not create a video stream.");

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
  });
  await page.locator(".app-shell").waitFor({ timeout: 20_000 });
  await caption("Jasmine — local-first AI workspace");
  await pause(1_100);

  await page.getByRole("button", { name: "New chat" }).first().click();
  await page.locator(".empty-state").waitFor();
  await caption("Start a private, local conversation");
  await pause(700);

  await page.locator(".model-pill").click();
  await page.locator(".model-menu").waitFor();
  await caption("Switch providers, models, and reasoning effort");
  await pause(1_200);
  await page.keyboard.press("Escape");

  await caption("Send a first message");
  await typeComposer("What context is being sent with this request?");
  await page.getByRole("button", { name: "Send" }).click();
  await waitForReply();
  await pause(700);

  await page.getByRole("button", { name: "Open Context taxonomy" }).click();
  await page.getByRole("complementary", { name: "Context taxonomy" }).waitFor();
  await page.locator(".taxonomy-warning-card").waitFor();
  await caption("Context Taxonomy reconstructs every context layer");
  await pause(1_100);

  const currentPrompt = page.locator(".taxonomy-item", { hasText: "Current user prompt" }).last();
  await currentPrompt.locator(".taxonomy-item-details > summary").click();
  await pause(500);
  await currentPrompt.locator(".taxonomy-item-details > summary").click();
  await pause(900);

  const initialSystem = page.locator(".taxonomy-item", { hasText: "System prompt" }).first();
  await ensureOpen(initialSystem.locator(".taxonomy-item-details").first());
  await pause(900);

  await caption("A second turn captures the exact provider payload");
  await typeComposer("show structured taxonomy");
  await page.getByRole("button", { name: "Send" }).click();
  await waitForReply();
  await page.locator(".taxonomy-summary", { hasText: "provider-payload" }).waitFor();
  await caption("Provider payload • schema v4 • cache evidence");
  await pause(1_300);

  const rawPayload = page.locator(".taxonomy-raw-payload");
  await rawPayload.scrollIntoViewIfNeeded();
  await rawPayload.locator("summary").click();
  await caption("Inspect the raw messages, tools, and options");
  await pause(1_500);
  await rawPayload.locator("summary").click();

  const toolDefinition = page.locator(".taxonomy-item", { hasText: "Tool definition: read" });
  await toolDefinition.scrollIntoViewIfNeeded();
  await ensureOpen(toolDefinition.locator(".taxonomy-item-details").first());
  await caption("Trace each tool definition back to its payload path");
  await pause(1_300);

  const structuredSystem = page.locator(".taxonomy-item", { hasText: "System prompt" }).first();
  await structuredSystem.scrollIntoViewIfNeeded();
  await ensureOpen(structuredSystem.locator(".taxonomy-item-details").first());
  const projectContext = structuredSystem.locator(".taxonomy-segment", { hasText: "Project context" });
  if (await projectContext.count()) {
    await ensureOpen(projectContext.first());
  }
  await caption("Separate project and skill instructions from the system prompt");
  await pause(1_400);

  await page.getByRole("button", { name: "Open Artifacts" }).click();
  await caption("Artifacts and terminal tools stay one click away");
  await pause(800);
  await page.getByRole("button", { name: "Open Terminal" }).click();
  await page.locator(".terminal-output").waitFor();
  await pause(900);
  await page.locator(".right-panel-tab", { hasText: "Context taxonomy" }).click();
  await pause(600);

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.locator(".side-menu").getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-nav").getByRole("button", { name: "Providers" }).click();
  await page.locator(".settings-subnav button").first().click();
  await page.locator(".provider-card").waitFor();
  await caption("Configure model providers without exposing saved secrets");
  await pause(1_300);

  const providerButtons = page.locator(".settings-subnav button");
  if (await providerButtons.count() > 1) {
    await providerButtons.nth(1).click();
    await pause(900);
    await providerButtons.first().click();
  }
  const modelOptions = page.locator(".model-options-button").first();
  if (await modelOptions.count()) {
    await modelOptions.click();
    await page.locator(".model-dialog").waitFor();
    await caption("Tune model-specific generation options");
    await pause(1_300);
    await page.getByRole("button", { name: "Cancel" }).click();
  }

  await caption("Jasmine v0.1.0 • Windows");
  await pause(1_500);
} finally {
  await app.close().catch(() => undefined);
}

if (!video) throw new Error("The Playwright video stream was unavailable.");
await video.saveAs(webmPath);
await run(ffmpeg, [
  "-y", "-i", webmPath,
  "-vf", "scale=1280:-2:flags=lanczos",
  "-c:v", "libx264", "-preset", "slow", "-crf", "25",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
  mp4Path
]);
await run(ffmpeg, [
  "-y", "-i", mp4Path,
  "-vf", "fps=5,scale=720:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=80[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4",
  "-loop", "0", gifPath
]);

for (const filePath of [webmPath, mp4Path, gifPath]) {
  const info = await stat(filePath);
  console.log(`${path.relative(rootDir, filePath)} ${(info.size / 1024 / 1024).toFixed(2)} MiB`);
}

async function caption(text) {
  await page.evaluate((value) => {
    let banner = document.querySelector(".jasmine-demo-caption");
    if (!(banner instanceof HTMLElement)) {
      banner = document.createElement("div");
      banner.className = "jasmine-demo-caption";
      Object.assign(banner.style, {
        position: "fixed",
        left: "50%",
        bottom: "22px",
        transform: "translateX(-50%)",
        zIndex: "2147483647",
        padding: "10px 16px",
        borderRadius: "10px",
        background: "rgba(12, 18, 28, 0.9)",
        border: "1px solid rgba(113, 164, 255, 0.55)",
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.28)",
        color: "#f4f7fb",
        font: "600 15px/1.3 system-ui, sans-serif",
        letterSpacing: "0.01em",
        pointerEvents: "none",
        whiteSpace: "nowrap"
      });
      document.body.appendChild(banner);
    }
    banner.textContent = value;
  }, text);
}

async function pause(milliseconds) {
  await page.waitForTimeout(milliseconds);
}

async function typeComposer(text) {
  const composer = page.locator(".rich-composer-editor");
  await composer.click();
  await composer.fill("");
  await composer.pressSequentially(text, { delay: 22 });
  await pause(450);
}

async function waitForReply() {
  await page.locator(".assistant-block").last().waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".assistant-block.live-message"), undefined, { timeout: 15_000 });
}

async function ensureOpen(details) {
  if (!(await details.count())) return;
  if ((await details.getAttribute("open")) === null) {
    await details.locator(":scope > summary").click();
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}
