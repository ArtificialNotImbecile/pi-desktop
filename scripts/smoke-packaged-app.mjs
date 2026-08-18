import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const rootDir = process.cwd();
const packageManifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const packageOutput = (packageManifest.build?.directories?.output || path.join("release", `v${packageManifest.version}`))
  .replace(/\$\{version\}/g, packageManifest.version);
const defaultExecutables = process.platform === "win32"
  ? [path.join(rootDir, packageOutput, "win-unpacked", "Jasmine.exe")]
  : process.platform === "darwin"
    ? [path.join(rootDir, packageOutput, "mac-arm64", "Jasmine.app", "Contents", "MacOS", "Jasmine")]
    : [path.join(rootDir, packageOutput, "linux-unpacked", "jasmine")];
const executablePath = path.resolve(process.argv[2] || await firstExistingPath(defaultExecutables));
const executableInfo = await stat(executablePath).catch(() => null);
if (!executableInfo?.isFile()) throw new Error(`Packaged Jasmine executable not found: ${executablePath}`);

const appResourcesRoot = process.platform === "darwin"
  ? path.resolve(path.dirname(executablePath), "..", "Resources")
  : path.join(path.dirname(executablePath), "resources");
const resourcesRoot = path.join(appResourcesRoot, "jasmine-resources");
const packagedInterLicense = path.join(appResourcesRoot, "third-party", "inter", "LICENSE.txt");
for (const requiredPath of [
  path.join(resourcesRoot, "builtin-skills", "code-reviewer", "SKILL.md"),
  path.join(resourcesRoot, "jasmine-logo.ico"),
  packagedInterLicense,
  path.join(appResourcesRoot, "THIRD_PARTY_LICENSES.md")
]) {
  const info = await stat(requiredPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Packaged resource missing: ${requiredPath}`);
}
const packagedInterLicenseHash = createHash("sha256").update(await readFile(packagedInterLicense)).digest("hex");
if (packagedInterLicenseHash !== "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a") {
  throw new Error(`Packaged Inter OFL text does not match upstream: ${packagedInterLicenseHash}`);
}
const retiredChromePackage = path.join(resourcesRoot, "builtin-plugins", "chrome", "package.json");
if (await stat(retiredChromePackage).catch(() => null)) {
  throw new Error(`Retired built-in Chrome package is still packaged: ${retiredChromePackage}`);
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
    await document.fonts.ready;
    const loadedFaces = await document.fonts.load('700 15px "Jasmine Inter"', "33632");
    const fontProbe = document.createElement("strong");
    fontProbe.textContent = "33632";
    fontProbe.style.cssText = "position: fixed; left: 0; top: 0; font: 700 15px 'Jasmine Inter', system-ui, sans-serif;";
    document.body.append(fontProbe);
    const fontStyle = getComputedStyle(fontProbe);
    const font = {
      family: fontStyle.fontFamily,
      weight: fontStyle.fontWeight,
      size: fontStyle.fontSize,
      loadedFaces: loadedFaces.map((face) => ({
        family: face.family,
        style: face.style,
        weight: face.weight,
        status: face.status
      }))
    };
    fontProbe.remove();
    const [providers, plugins, skills, appSettings, updateState] = await Promise.all([
      window.jasmine.listProviders(),
      window.jasmine.listPlugins(),
      window.jasmine.listSkills(),
      window.jasmine.getAppSettings(),
      window.jasmine.getAppUpdateState()
    ]);
    return {
      title: document.title,
      bodyTextLength: document.body.innerText.trim().length,
      providerCount: providers.length,
      pluginNames: plugins.map((item) => item.displayName),
      pluginSources: plugins.map((item) => item.source),
      skillNames: skills.map((item) => item.name),
      language: appSettings.language,
      updateState,
      font
    };
  });

  // An installer build ships app-update.yml; the `dir` target does not. Either
  // way the About page has to resolve to a coherent state before any check runs
  // -- a build with a feed reports itself updatable, and a build without one
  // reports the manual download route rather than failing every check with the
  // raw ENOENT electron-updater raises for the missing file.
  const hasUpdateFeed = Boolean(await stat(path.join(appResourcesRoot, "app-update.yml")).catch(() => null));
  const { supported, installMode, phase } = result.updateState;
  if (hasUpdateFeed) {
    if (!supported) throw new Error(`Packaged build ships app-update.yml but reports updates as unsupported: ${phase}`);
  } else if (supported || installMode !== "manual" || phase !== "unsupported") {
    throw new Error(
      `Packaged build ships no app-update.yml and must offer the manual download route, got ${JSON.stringify(result.updateState)}`
    );
  }
  console.log(`Packaged update feed ${hasUpdateFeed ? "present" : "absent"}; About reports ${phase}/${installMode}.`);
  if (result.title !== "Jasmine — The desktop app for Pi" || result.bodyTextLength < 100) {
    throw new Error(`Packaged renderer is blank or mislabeled: ${JSON.stringify(result)}`);
  }
  if (result.pluginNames.some((name) => /^chrome$/i.test(name))) throw new Error(`Retired Chrome package was discovered: ${JSON.stringify(result)}`);
  if (!result.skillNames.includes("code-reviewer")) throw new Error(`Packaged built-in skills were not discovered: ${JSON.stringify(result)}`);
  if (result.language !== "en") {
    throw new Error(`Packaged legacy database migration failed: ${JSON.stringify(result)}`);
  }
  if (!result.font.family.startsWith('"Jasmine Inter"') || result.font.weight !== "700" || result.font.size !== "15px") {
    throw new Error(`Packaged renderer does not compute the deterministic Inter family and weight: ${JSON.stringify(result.font)}`);
  }
  if (!result.font.loadedFaces.some((face) =>
    face.family === "Jasmine Inter" && face.style === "normal" && face.weight === "100 900" && face.status === "loaded")) {
    throw new Error(`Packaged renderer did not load the bundled Inter variable face: ${JSON.stringify(result.font)}`);
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

// The retired MCP feature seeded a table above. Reading it back through the app
// is impossible now that the bridge method is gone, so assert against the file
// the packaged app just migrated.
const migratedDb = new DatabaseSync(path.join(userDataDir, "data", "jasmine.sqlite"));
try {
  const survivors = migratedDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_servers'")
    .all();
  if (survivors.length > 0) throw new Error("Packaged migration left the retired mcp_servers table behind.");
  const appSettingsColumns = migratedDb.prepare("PRAGMA table_info(app_settings)").all().map((row) => row.name);
  const retiredColumns = appSettingsColumns.filter((name) => name.startsWith("chrome_takeover_"));
  if (retiredColumns.length > 0) {
    throw new Error(`Packaged migration left retired Chrome columns behind: ${retiredColumns.join(", ")}`);
  }
} finally {
  migratedDb.close();
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (await stat(candidate).catch(() => null)) return candidate;
  }
  return candidates[0];
}
