import { _electron as electron } from "playwright";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const rootDir = process.cwd();

const redSquareBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGElEQVR4nGP8z8Dwn4ECwESJ5lEDRgAAUOQCH2mP8toAAAAASUVORK5CYII=";

export function electronExecutablePath() {
  return path.join(
    rootDir,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron"
  );
}

export async function resetDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

export async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true });
}

export async function createRedSquare(userDataDir) {
  const redSquarePath = path.join(userDataDir, "red-square.png");
  await writeFile(redSquarePath, Buffer.from(redSquareBase64, "base64"));
  return redSquarePath;
}

export async function launchHarnessApp({ userDataDir, env = {}, args = [".", "--disable-gpu"] }) {
  return electron.launch({
    executablePath: electronExecutablePath(),
    args,
    cwd: rootDir,
    env: {
      ...process.env,
      JASMINE_E2E_OFFSCREEN: process.env.JASMINE_E2E_OFFSCREEN ?? "1",
      JASMINE_E2E_USER_DATA_DIR: userDataDir,
      DEEPSEEK_API_KEY: "e2e-mock-key",
      KIMI_API_KEY: "e2e-mock-key",
      ...env
    }
  });
}

export function escapePipe(value) {
  return String(value).replace(/\|/g, "\\|");
}

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}
