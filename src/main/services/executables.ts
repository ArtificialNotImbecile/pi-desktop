import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecutableCandidate, ExecutableDiscovery, ExecutablePickerKind } from "../../shared/ipc.js";
import { gitBashCandidates, isGitBashPath, isWindowsBashLauncherPath } from "../utils/shellPaths.js";

type CandidateSpec = {
  label: string;
  commands?: string[];
  registryExecutables?: string[];
  commonPaths?: string[];
  systemPath?: string;
};

// Discovery shells out to where.exe/reg.exe many times. Synchronous spawns
// blocked the main process for seconds when Settings General mounted, so
// detection is async and the result is cached for the process lifetime
// (installed editors/shells do not change mid-session; the manual picker
// still lets users select anything).
const discoveryCache = new Map<ExecutablePickerKind, Promise<ExecutableDiscovery>>();

export function listExecutableDiscovery(kind: ExecutablePickerKind): Promise<ExecutableDiscovery> {
  const e2eCandidates = readE2eCandidates(kind);
  if (e2eCandidates) {
    return Promise.resolve({ kind, auto: e2eCandidates[0], candidates: e2eCandidates });
  }
  const cached = discoveryCache.get(kind);
  if (cached) return cached;
  const discovery = (async (): Promise<ExecutableDiscovery> => {
    const candidates = kind === "editor" ? await detectEditors() : await detectTerminalShells();
    return { kind, auto: candidates[0], candidates };
  })();
  discoveryCache.set(kind, discovery);
  discovery.catch(() => {
    if (discoveryCache.get(kind) === discovery) discoveryCache.delete(kind);
  });
  return discovery;
}

export async function resolveConfiguredExecutable(kind: ExecutablePickerKind, configuredPath?: string): Promise<ExecutableCandidate | null> {
  const configured = configuredPath?.trim();
  if (!configured) return null;
  const resolvedCommand = await resolveExecutablePath(configured);
  if (!resolvedCommand) return null;
  return {
    label: kind === "terminal" ? labelForTerminal(resolvedCommand) : labelForEditor(resolvedCommand),
    command: resolvedCommand,
    source: "configured"
  };
}

async function detectEditors(): Promise<ExecutableCandidate[]> {
  const localPrograms = path.join(os.homedir(), "AppData", "Local", "Programs");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return collectCandidates(await Promise.all([
    detectEditorCandidate({
      label: "VS Code",
      commands: ["code"],
      registryExecutables: ["Code.exe"],
      commonPaths: [
        path.join(localPrograms, "Microsoft VS Code", "Code.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft VS Code", "Code.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft VS Code", "Code.exe")
      ]
    }),
    detectEditorCandidate({
      label: "Cursor",
      commands: ["cursor"],
      registryExecutables: ["Cursor.exe"],
      commonPaths: [
        path.join(localPrograms, "Cursor", "Cursor.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Cursor", "Cursor.exe")
      ]
    }),
    detectEditorCandidate({
      label: "Windsurf",
      commands: ["windsurf"],
      registryExecutables: ["Windsurf.exe"],
      commonPaths: [
        path.join(localPrograms, "Windsurf", "Windsurf.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Windsurf", "Windsurf.exe")
      ]
    }),
    detectEditorCandidate({
      label: "Notepad++",
      commands: ["notepad++"],
      registryExecutables: ["notepad++.exe"],
      commonPaths: [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Notepad++", "notepad++.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Notepad++", "notepad++.exe")
      ]
    }),
    detectEditorCandidate({
      label: "Sublime Text",
      commands: ["subl", "sublime_text"],
      registryExecutables: ["sublime_text.exe"],
      commonPaths: [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Sublime Text", "sublime_text.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Sublime Text", "sublime_text.exe")
      ]
    }),
    detectEditorCandidate({
      label: "Notepad",
      commands: ["notepad"],
      commonPaths: [path.join(systemRoot, "System32", "notepad.exe")],
      systemPath: path.join(systemRoot, "System32", "notepad.exe")
    }),
    detectEditorCandidate({
      label: "Vim",
      commands: ["vim", "gvim"],
      commonPaths: [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Vim", "vim91", "gvim.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Vim", "vim91", "gvim.exe")
      ]
    }),
    detectEditorCandidate({
      label: "Neovim",
      commands: ["nvim", "nvim-qt"],
      commonPaths: [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Neovim", "bin", "nvim.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Neovim", "bin", "nvim.exe")
      ]
    })
  ]));
}

async function detectTerminalShells(): Promise<ExecutableCandidate[]> {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return collectCandidates(await Promise.all([
    detectTerminalCandidate({
      label: "Nushell",
      commands: ["nu.exe", "nu"]
    }),
    detectTerminalCandidate({
      label: "Git Bash",
      commonPaths: gitBashCandidates(),
      commands: ["bash.exe", "bash"]
    }),
    detectTerminalCandidate({
      label: "PowerShell",
      commands: ["pwsh.exe", "pwsh", "powershell.exe", "powershell"],
      commonPaths: [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
        path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      ],
      systemPath: path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    }),
    detectTerminalCandidate({
      label: "Command Prompt",
      commands: ["cmd.exe", "cmd"],
      systemPath: process.env.ComSpec || path.join(systemRoot, "System32", "cmd.exe")
    })
  ]));
}

async function detectEditorCandidate(spec: CandidateSpec): Promise<ExecutableCandidate | null> {
  const appPath = await firstResolved(spec.registryExecutables ?? [], findWindowsAppPath);
  if (appPath) return { label: spec.label, command: appPath, source: "app-paths" };
  const fromPath = await firstResolved(spec.commands ?? [], findCommand);
  if (fromPath) return { label: spec.label, command: fromPath, source: "path" };
  const commonPath = spec.commonPaths?.find(pathExists);
  if (commonPath) return { label: spec.label, command: commonPath, source: "common-path" };
  const systemPath = spec.systemPath && pathExists(spec.systemPath) ? spec.systemPath : null;
  return systemPath ? { label: spec.label, command: systemPath, source: "system" } : null;
}

async function detectTerminalCandidate(spec: CandidateSpec): Promise<ExecutableCandidate | null> {
  const commonPath = spec.commonPaths?.find(pathExists);
  if (commonPath) return { label: spec.label, command: commonPath, source: "common-path" };
  const fromPath = await firstResolved(spec.commands ?? [], async (command) => {
    const found = await findCommand(command);
    return found && isAllowedTerminalCommand(spec, found) ? found : null;
  });
  if (fromPath) return { label: terminalLabelForCandidate(spec, fromPath), command: fromPath, source: "path" };
  const systemPath = spec.systemPath && pathExists(spec.systemPath) ? spec.systemPath : null;
  return systemPath ? { label: spec.label, command: systemPath, source: "system" } : null;
}

async function firstResolved(values: string[], resolve: (value: string) => Promise<string | null>): Promise<string | null> {
  // Candidates within a spec are ordered by preference, so results must be
  // checked in order, but the lookups themselves can run concurrently.
  const results = await Promise.all(values.map(resolve));
  return results.find(Boolean) ?? null;
}

function isAllowedTerminalCommand(spec: CandidateSpec, command: string): boolean {
  if (spec.label === "Git Bash" && isWindowsBashLauncherPath(command)) return false;
  return true;
}

function terminalLabelForCandidate(spec: CandidateSpec, command: string): string {
  if (spec.label === "Git Bash" && !isGitBashPath(command)) return labelForTerminal(command);
  return spec.label;
}

function collectCandidates(items: Array<ExecutableCandidate | null>): ExecutableCandidate[] {
  const seen = new Set<string>();
  const candidates: ExecutableCandidate[] = [];
  for (const item of items) {
    if (!item) continue;
    const key = normalizePathKey(item.command);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(item);
  }
  return candidates;
}

function readE2eCandidates(kind: ExecutablePickerKind): ExecutableCandidate[] | null {
  const raw = kind === "terminal" ? process.env.JASMINE_E2E_TERMINAL_CANDIDATES : process.env.JASMINE_E2E_EDITOR_CANDIDATES;
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Array<{ label?: unknown; command?: unknown; source?: unknown }>;
    const validSources = new Set<ExecutableCandidate["source"]>(["path", "app-paths", "common-path", "system", "configured", "e2e"]);
    return collectCandidates(parsed
      .filter((item) => typeof item?.label === "string" && typeof item?.command === "string")
      .map((item): ExecutableCandidate => ({
        label: String(item.label).trim(),
        command: String(item.command).trim(),
        source: validSources.has(item.source as ExecutableCandidate["source"]) ? item.source as ExecutableCandidate["source"] : "e2e"
      }))
      .filter((item) => item.label && item.command));
  } catch {
    return null;
  }
}

async function resolveExecutablePath(value: string): Promise<string | null> {
  if (pathExists(value)) return value;
  if (value.includes("\\") || value.includes("/") || value.includes(":")) return null;
  return findCommand(value);
}

function findCommand(command: string): Promise<string | null> {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  return runCapture(lookup, [command]).then((stdout) => {
    if (stdout === null) return null;
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => pathExists(line));
    return first || null;
  });
}

async function findWindowsAppPath(executable: string): Promise<string | null> {
  if (process.platform !== "win32") return null;
  for (const root of [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths"
  ]) {
    const stdout = await runCapture("reg.exe", ["query", `${root}\\${executable}`, "/ve"]);
    if (stdout === null) continue;
    const match = stdout.match(/REG_\w+\s+(.+)/);
    const value = match?.[1]?.trim();
    const expanded = value ? expandWindowsEnv(stripWrappingQuotes(value)) : "";
    if (expanded && pathExists(expanded)) return expanded;
  }
  return null;
}

function runCapture(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? stdout : null));
  });
}

function expandWindowsEnv(value: string): string {
  return value.replace(/%([^%]+)%/g, (_match, key: string) => process.env[key] || `%${key}%`);
}

function stripWrappingQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function pathExists(filePath: string): boolean {
  return Boolean(filePath) && existsSync(filePath);
}

function normalizePathKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

function labelForTerminal(command: string): string {
  const basename = path.basename(command).toLowerCase();
  if (basename === "nu.exe" || basename === "nu") return "Nushell";
  if (isWindowsBashLauncherPath(command)) return "WSL Bash";
  if (isGitBashPath(command)) return "Git Bash";
  if (basename === "bash.exe" || basename === "bash") return "Bash";
  if (basename === "pwsh.exe" || basename === "pwsh" || basename === "powershell.exe" || basename === "powershell") return "PowerShell";
  if (basename === "cmd.exe" || basename === "cmd") return "Command Prompt";
  return path.basename(command);
}

function labelForEditor(command: string): string {
  const basename = path.basename(command).toLowerCase();
  if (basename === "code.exe" || basename === "code.cmd" || basename === "code") return "VS Code";
  if (basename === "cursor.exe" || basename === "cursor.cmd" || basename === "cursor") return "Cursor";
  if (basename === "windsurf.exe" || basename === "windsurf.cmd" || basename === "windsurf") return "Windsurf";
  if (basename === "notepad++.exe" || basename === "notepad++") return "Notepad++";
  if (basename === "subl.exe" || basename === "sublime_text.exe" || basename === "subl" || basename === "sublime_text") return "Sublime Text";
  if (basename === "notepad.exe" || basename === "notepad") return "Notepad";
  if (basename === "vim.exe" || basename === "gvim.exe" || basename === "vim" || basename === "gvim") return "Vim";
  if (basename === "nvim.exe" || basename === "nvim-qt.exe" || basename === "nvim" || basename === "nvim-qt") return "Neovim";
  return path.basename(command);
}
