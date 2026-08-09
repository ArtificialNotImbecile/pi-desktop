import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const rootDir = process.cwd();
const executablePath = path.resolve(process.argv[2] || path.join(rootDir, "release", "v0.1.1", "win-unpacked", "Jasmine.exe"));
const executableInfo = await stat(executablePath).catch(() => null);
if (!executableInfo?.isFile()) throw new Error(`Packaged Jasmine executable not found: ${executablePath}`);

const resourcesRoot = path.join(path.dirname(executablePath), "resources", "jasmine-resources");
for (const requiredPath of [
  path.join(resourcesRoot, "chrome-extension", "manifest.json"),
  path.join(resourcesRoot, "builtin-plugins", "chrome", "package.json"),
  path.join(resourcesRoot, "builtin-skills", "code-reviewer", "SKILL.md"),
  path.join(resourcesRoot, "jasmine-logo.ico")
]) {
  const info = await stat(requiredPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Packaged resource missing: ${requiredPath}`);
}

const outputDir = path.join(rootDir, "test-results", "ui-harness", "release");
const userDataDir = path.join(rootDir, ".tmp", "packaged-smoke");
await mkdir(outputDir, { recursive: true });
await rm(userDataDir, { recursive: true, force: true });
await mkdir(path.join(userDataDir, "data"), { recursive: true });
const legacyDb = new DatabaseSync(path.join(userDataDir, "data", "jasmine.sqlite"));
try {
  legacyDb.exec(`
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      env_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO mcp_servers (id, name, command, args_json, env_json, enabled, created_at, updated_at)
    VALUES ('legacy-packaged-mcp', 'Legacy packaged MCP', 'legacy-command', '[]', '{}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
} finally {
  legacyDb.close();
}

const app = await electron.launch({
  executablePath,
  args: ["--disable-gpu"],
  cwd: path.dirname(executablePath),
  env: {
    ...process.env,
    JASMINE_E2E_HARNESS: "1",
    JASMINE_E2E_OFFSCREEN: "1",
    JASMINE_E2E_MOCK_AI: "1",
    JASMINE_E2E_USER_DATA_DIR: userDataDir,
    DEEPSEEK_API_KEY: "packaged-smoke-placeholder"
  }
});

app.process().stdout?.on("data", (chunk) => process.stdout.write(`[packaged stdout] ${chunk}`));
app.process().stderr?.on("data", (chunk) => process.stderr.write(`[packaged stderr] ${chunk}`));

try {
  const page = await app.firstWindow();
  page.on("console", (message) => console.log(`[renderer ${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[renderer error] ${error.stack || error.message}`));
  try {
    await page.locator(".app-shell").waitFor({ timeout: 30_000 });
  } catch (error) {
    const diagnostics = {
      url: page.url(),
      title: await page.title().catch(() => ""),
      body: await page.locator("body").innerText().catch(() => "")
    };
    await page.screenshot({ path: path.join(outputDir, "packaged-startup-failure.png") }).catch(() => undefined);
    console.error(JSON.stringify(diagnostics, null, 2));
    throw error;
  }
  const result = await page.evaluate(async () => {
    const [providers, plugins, skills, appSettings, mcpServers] = await Promise.all([
      window.jasmine.listProviders(),
      window.jasmine.listPlugins(),
      window.jasmine.listSkills(),
      window.jasmine.getAppSettings(),
      window.jasmine.listMcpServers()
    ]);
    return {
      title: document.title,
      bodyTextLength: document.body.innerText.trim().length,
      providerCount: providers.length,
      pluginNames: plugins.map((item) => item.displayName),
      pluginSources: plugins.map((item) => item.source),
      skillNames: skills.map((item) => item.name),
      language: appSettings.language,
      legacyMcp: mcpServers.find((item) => item.id === "legacy-packaged-mcp") ?? null
    };
  });
  if (result.title !== "Jasmine — The desktop app for Pi" || result.bodyTextLength < 100) {
    throw new Error(`Packaged renderer is blank or mislabeled: ${JSON.stringify(result)}`);
  }
  if (!result.pluginNames.some((name) => /chrome/i.test(name))) throw new Error(`Packaged Chrome plugin was not discovered: ${JSON.stringify(result)}`);
  if (!result.skillNames.includes("code-reviewer")) throw new Error(`Packaged built-in skills were not discovered: ${JSON.stringify(result)}`);
  if (result.language !== "en" || result.legacyMcp?.transport !== "stdio" || result.legacyMcp?.source !== "manual") {
    throw new Error(`Packaged legacy database migration failed: ${JSON.stringify(result)}`);
  }

  const terminalOutput = await page.evaluate(async () => {
    const marker = "JASMINE_PACKAGED_TERMINAL_OK";
    const session = await window.jasmine.startTerminal({ cols: 80, rows: 24 });
    return new Promise((resolve, reject) => {
      let output = "";
      const timeout = window.setTimeout(() => {
        unsubscribe();
        void window.jasmine.stopTerminal({ sessionId: session.id });
        reject(new Error(`Packaged terminal did not emit the marker. Output: ${output}`));
      }, 15_000);
      const unsubscribe = window.jasmine.onTerminalEvent((event) => {
        if (event.sessionId !== session.id) return;
        if (event.data) output += event.data;
        if (!output.includes(marker)) return;
        window.clearTimeout(timeout);
        unsubscribe();
        void window.jasmine.stopTerminal({ sessionId: session.id });
        resolve(output);
      });
      void window.jasmine.writeTerminal({ sessionId: session.id, data: `echo ${marker}\r` });
    });
  });
  console.log(`Packaged terminal marker received (${String(terminalOutput).length} characters).`);

  await page.screenshot({ path: path.join(outputDir, "packaged-smoke.png") });
  await writeFile(path.join(outputDir, "packaged-smoke.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app.close().catch(() => undefined);
}
