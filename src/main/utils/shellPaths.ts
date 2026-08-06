import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function isWindowsBashLauncherPath(filePath: string): boolean {
  if (process.platform !== "win32") return false;
  const normalized = normalizeWindowsPath(filePath);
  return normalized.endsWith("\\windows\\system32\\bash.exe")
    || normalized.endsWith("\\windows\\sysnative\\bash.exe")
    || normalized.endsWith("\\microsoft\\windowsapps\\bash.exe");
}

export function isGitBashPath(filePath: string): boolean {
  if (process.platform !== "win32") return false;
  const normalized = normalizeWindowsPath(filePath);
  return normalized.endsWith("\\git\\bin\\bash.exe") || normalized.endsWith("\\git\\usr\\bin\\bash.exe");
}

export function findGitBashPath(): string | null {
  if (process.platform !== "win32") return null;
  return gitBashCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

export function gitBashCandidates(): string[] {
  const localPrograms = path.join(os.homedir(), "AppData", "Local", "Programs");
  return [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(localPrograms, "Git", "bin", "bash.exe")
  ];
}

function normalizeWindowsPath(filePath: string): string {
  return path.resolve(filePath).replace(/\//g, "\\").toLowerCase();
}
