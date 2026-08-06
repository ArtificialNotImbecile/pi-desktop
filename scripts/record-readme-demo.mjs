import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";

const rootDir = process.cwd();
const outputDir = path.join(rootDir, "test-results", "readme-demo");
const rawDir = path.join(outputDir, "raw");
const rawWebmPath = path.join(outputDir, "jasmine-product-demo.webm");
const userDataDir = path.join(rootDir, ".tmp", "readme-demo");
const demoProjectDir = path.join(userDataDir, "Jasmine Demo Workspace");
const assetDir = path.join(rootDir, "docs", "assets");
const mp4Path = path.join(assetDir, "jasmine-product-demo.mp4");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

await rm(outputDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
await mkdir(rawDir, { recursive: true });
await mkdir(demoProjectDir, { recursive: true });
await mkdir(path.join(demoProjectDir, "src"), { recursive: true });
await mkdir(assetDir, { recursive: true });
await writeFile(path.join(demoProjectDir, "AGENTS.md"), "# Demo workspace\n\nKeep answers concise and cite relevant project files.\n", "utf8");
await writeFile(path.join(demoProjectDir, "src", "overview.md"), "# Product overview\n\nJasmine is a local-first AI workspace.\n", "utf8");

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
    JASMINE_DEFAULT_PROJECT_ROOT: demoProjectDir,
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

  await page.locator(".app-shell").waitFor({ timeout: 20_000 });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
  });
  await page.locator(".project-row", { hasText: "Jasmine Demo Workspace" }).waitFor();
  await page.evaluate(async () => {
    await Promise.all([
      window.jasmine.addTodo({ text: "Review the Windows release checklist" }),
      window.jasmine.createMemory({ content: "Prefer concise answers with concrete next steps." }),
      window.jasmine.createManualActivityObservation({ note: "Prepared the Jasmine product walkthrough." })
    ]);
  });

  await caption("A local-first workspace for everyday AI work");
  await pause(1_400);

  const projectRow = page.locator(".project-row", { hasText: "Jasmine Demo Workspace" }).first();
  await projectRow.locator(".project-item").click();
  await caption("Organize conversations around local projects and files");
  await pause(1_300);

  await page.getByRole("button", { name: "TODO" }).click();
  await page.locator(".todo-page").waitFor();
  await caption("Capture durable tasks in local Markdown files");
  await pause(1_200);
  await projectRow.locator(".project-item").click();
  await page.locator(".empty-state").waitFor();

  await page.locator(".model-pill").click();
  await page.locator(".model-menu").waitFor();
  await caption("Choose a provider, model, and reasoning effort per chat");
  await pause(1_200);
  await page.keyboard.press("Escape");

  await page.locator(".composer").getByRole("button", { name: "Tools" }).click();
  await page.locator(".tools-menu").waitFor();
  await caption("Bring tools, web access, and plugins into the composer");
  await pause(1_100);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Skills" }).click();
  await page.locator(".skill-menu").waitFor();
  await caption("Apply reusable skills without leaving the conversation");
  await pause(1_100);
  await page.keyboard.press("Escape");

  await caption("Work with the assistant in a persistent project thread");
  await sendMessage("Summarize this workspace and suggest the next release task.");
  await pause(900);

  await page.getByRole("button", { name: "Open Context taxonomy" }).click();
  await page.getByRole("complementary", { name: "Context taxonomy" }).waitFor();
  await page.locator(".taxonomy-warning-card").waitFor();
  await caption("Inspect exactly what was assembled for the model");
  await pause(1_500);

  const initialSystem = page.locator(".taxonomy-item", { hasText: "System prompt" }).first();
  await ensureOpen(initialSystem.locator(".taxonomy-item-details").first());
  await pause(900);
  const projectContext = initialSystem.locator(".taxonomy-segment", { hasText: "Project context" });
  if (await projectContext.count()) await ensureOpen(projectContext.first());
  await caption("Trace system, project, skill, conversation, and tool context");
  await pause(1_500);

  await sendMessage("show structured taxonomy");
  await page.getByRole("button", { name: "Close Context taxonomy tab" }).click();
  await page.getByRole("button", { name: "Open Context taxonomy" }).click();
  await page.getByRole("complementary", { name: "Context taxonomy" }).waitFor();
  await page.locator(".taxonomy-summary", { hasText: "provider-payload" }).waitFor();
  await caption("Compare turns, cache evidence, options, and payload shape");
  await pause(1_500);

  const rawPayload = page.locator(".taxonomy-raw-payload");
  await rawPayload.scrollIntoViewIfNeeded();
  await rawPayload.locator("summary").click();
  await caption("Open the raw provider request when deeper debugging is needed");
  await pause(1_600);
  await rawPayload.locator("summary").click();

  await page.getByRole("button", { name: "Open Artifacts" }).click();
  await caption("Keep generated artifacts beside the active conversation");
  await pause(1_100);
  await page.getByRole("button", { name: "Open Terminal" }).click();
  await page.locator(".terminal-output").waitFor();
  await caption("Use a real project-scoped terminal without changing apps");
  await pause(1_300);

  for (const tabCloseLabel of ["Close Terminal tab", "Close Artifacts tab", "Close Context taxonomy tab"]) {
    const closeButton = page.getByRole("button", { name: tabCloseLabel, exact: true });
    if (await closeButton.count()) await closeButton.click();
  }

  await page.locator(".message-scroll").click({ position: { x: 24, y: 24 } });
  await page.keyboard.press("Control+K");
  await page.locator(".command-panel").waitFor();
  await caption("Jump anywhere with the command palette");
  await pause(1_000);
  await page.locator(".command-panel").getByRole("button", { name: "Memory" }).click();
  await page.locator(".memory-panel").waitFor();
  await page.getByRole("button", { name: "Refresh memories" }).click();
  await page.locator(".memory-row").waitFor();
  await caption("Keep explicit, inspectable memory under your control");
  await pause(1_300);
  await page.getByRole("button", { name: "Close memory panel" }).click();

  await page.keyboard.press("Control+K");
  await page.locator(".command-panel").getByRole("button", { name: "Activity" }).click();
  await page.locator(".activity-panel").waitFor();
  await page.getByRole("button", { name: "Refresh activity" }).click();
  await page.locator(".activity-row").waitFor();
  await caption("Review local activity with clear privacy controls");
  await pause(1_300);
  await page.getByRole("button", { name: "Close activity panel" }).click();

  await page.locator(".side-top").getByRole("button", { name: "Search" }).click();
  await page.getByPlaceholder("Search chats").fill("Summarize");
  await caption("Search persistent chats and return to prior work");
  await pause(1_200);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.locator(".side-menu").getByRole("button", { name: "Settings" }).click();
  await page.locator(".settings-nav").waitFor();
  await caption("Configure the workspace from one settings surface");
  await pause(1_000);

  await showSetting("Providers", "Connect providers and tune model-specific options", 1_250);
  const modelOptions = page.locator(".model-options-button").first();
  if (await modelOptions.count()) {
    await modelOptions.click();
    await page.locator(".model-dialog").waitFor();
    await pause(1_100);
    await page.getByRole("button", { name: "Cancel" }).click();
  }
  await showSetting("Appearance", "Choose the look, language, and workspace identity", 900);
  await showSetting("Skills", "Manage local and shared skills", 750);
  await showSetting("Plugins", "Install and control plugin packages", 750);
  await showSetting("Chrome Control", "Enable browser control only when you need it", 750);
  await showSetting("Prompt Templates", "Reuse prompt templates across conversations", 750);
  await showSetting("Remote", "Work against remote coding targets", 750);
  await showSetting("MCP Servers", "Connect additional tools through MCP", 850);
  await showSetting("Web Search", "Select and constrain web search behavior", 750);
  await showSetting("About", "Jasmine v0.1.0 for Windows", 1_300);
} finally {
  await app.close().catch(() => undefined);
}

if (!video) throw new Error("The Playwright video stream was unavailable.");
await video.saveAs(rawWebmPath);
await run(ffmpeg, [
  "-y", "-i", rawWebmPath,
  "-vf", "scale=1280:-2:flags=lanczos",
  "-c:v", "libx264", "-preset", "slow", "-crf", "24",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
  mp4Path
]);

const info = await stat(mp4Path);
console.log(`${path.relative(rootDir, mp4Path)} ${(info.size / 1024 / 1024).toFixed(2)} MiB`);

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
        maxWidth: "80%",
        padding: "10px 16px",
        borderRadius: "10px",
        background: "rgba(12, 18, 28, 0.9)",
        border: "1px solid rgba(113, 164, 255, 0.55)",
        boxShadow: "0 10px 30px rgba(0, 0, 0, 0.28)",
        color: "#f4f7fb",
        font: "600 15px/1.3 system-ui, sans-serif",
        letterSpacing: "0.01em",
        pointerEvents: "none",
        textAlign: "center",
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

async function sendMessage(text) {
  const assistantBlocks = page.locator(".assistant-block");
  const previousCount = await assistantBlocks.count();
  const composer = page.locator(".rich-composer-editor");
  await composer.click();
  await composer.fill("");
  await composer.pressSequentially(text, { delay: 18 });
  await pause(350);
  await page.getByRole("button", { name: "Send" }).click();
  await assistantBlocks.nth(previousCount).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".assistant-block.live-message"), undefined, { timeout: 15_000 });
}

async function showSetting(label, text, milliseconds) {
  await page.locator(".settings-nav").getByRole("button", { name: label, exact: true }).click();
  await caption(text);
  await pause(milliseconds);
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
