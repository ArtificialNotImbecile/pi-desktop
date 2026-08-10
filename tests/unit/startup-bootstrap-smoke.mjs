import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const tempDir = path.join(os.tmpdir(), `jasmine-startup-bootstrap-${process.pid}`);
const entryPath = path.join(tempDir, "dist", "main", "main", "main.js");
const writerPath = path.join(tempDir, "write-entry.mjs");
const electronDistribution = path.join(rootDir, "node_modules", "electron", "dist");
const executablePath = process.platform === "win32"
  ? path.join(electronDistribution, "electron.exe")
  : process.platform === "darwin"
    ? path.join(electronDistribution, "Electron.app", "Contents", "MacOS", "Electron")
    : path.join(electronDistribution, "electron");

await rm(tempDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });

try {
  await writeFile(path.join(tempDir, "package.json"), JSON.stringify({
    name: "jasmine-bootstrap-smoke",
    version: "0.0.0",
    type: "module",
    main: "main.cjs"
  }, null, 2));
  await writeFile(path.join(tempDir, "main.cjs"), await readFile(path.join(rootDir, "main.cjs"), "utf8"));
  await writeFile(writerPath, [
    "import { mkdir, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    `const entryPath = ${JSON.stringify(entryPath)};`,
    "await mkdir(path.dirname(entryPath), { recursive: true });",
    "await writeFile(entryPath, `",
    "  import { app, BrowserWindow } from 'electron';",
    "  app.whenReady().then(async () => {",
    "    const win = new BrowserWindow({ width: 480, height: 320, show: false });",
    "    await win.loadURL('data:text/html,<main data-bootstrap-ok=\"true\">bootstrapped</main>');",
    "    win.show();",
    "  });",
    "`);"
  ].join("\n"));

  const app = await electron.launch({
    executablePath,
    args: [tempDir, "--disable-gpu"],
    env: {
      ...process.env,
      JASMINE_BOOTSTRAP_APP_ROOT: tempDir,
      JASMINE_BOOTSTRAP_MAIN_ENTRY: entryPath,
      JASMINE_BOOTSTRAP_BUILD_COMMAND: `"${process.execPath}" "${writerPath}"`
    }
  });

  try {
    const page = await app.firstWindow();
    await page.waitForSelector("[data-bootstrap-ok='true']");
    assert.equal(await page.locator("[data-bootstrap-ok='true']").textContent(), "bootstrapped");
  } finally {
    await app.close().catch(() => undefined);
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
