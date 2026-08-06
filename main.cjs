const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, dialog } = require("electron");

const appRoot = path.resolve(process.env.JASMINE_BOOTSTRAP_APP_ROOT || __dirname);
const mainEntry = path.resolve(appRoot, process.env.JASMINE_BOOTSTRAP_MAIN_ENTRY || path.join("dist", "main", "main", "main.js"));

if (!existsSync(mainEntry)) {
  rebuildMainEntry();
}

if (!existsSync(mainEntry)) {
  failStartup(`Jasmine main bundle is missing:\n${mainEntry}\n\nRun npm run build and launch Jasmine again.`);
} else {
  import(pathToFileURL(mainEntry).href).catch((error) => {
    failStartup(error instanceof Error ? error.stack || error.message : String(error));
  });
}

function rebuildMainEntry() {
  if (app.isPackaged || process.env.JASMINE_BOOTSTRAP_DISABLE_REBUILD === "1") return;
  const command = process.env.JASMINE_BOOTSTRAP_BUILD_COMMAND;
  const result = command
    ? spawnSync(command, { cwd: appRoot, env: process.env, shell: true, stdio: "inherit", windowsHide: true })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: appRoot,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
  if (result.error) {
    failStartup(result.error.stack || result.error.message);
  }
}

function failStartup(message) {
  const detail = String(message || "Unknown startup error.");
  console.error(detail);
  try {
    dialog.showErrorBox("Error launching app", `Jasmine could not start.\n\n${detail}`);
  } catch {
    // Electron may be too early in startup to display a native dialog.
  }
  if (app.isReady()) {
    app.quit();
  } else {
    process.exitCode = 1;
    app.once("ready", () => app.quit());
  }
}
