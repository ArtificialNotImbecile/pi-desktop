import { existsSync } from "node:fs";
import path from "node:path";
import { spawn as spawnPty, type IPty } from "node-pty";
import type { TerminalShellInfo } from "../../shared/ipc.js";
import { listExecutableDiscovery, resolveConfiguredExecutable } from "./executables.js";

export type TerminalProcess = {
  id: string;
  shell: TerminalShellInfo;
  cwd: string;
  startedAt: string;
  pty: IPty;
};

export async function resolveTerminalShell(configuredPath?: string): Promise<TerminalShellInfo> {
  const configured = await resolveConfiguredExecutable("terminal", configuredPath);
  if (configured && configuredPath?.trim()) {
    return {
      command: configured.command,
      args: shellArgs(configured.command),
      label: configured.label,
      source: "configured"
    };
  }

  const auto = (await listExecutableDiscovery("terminal")).auto;
  if (auto) {
    return {
      command: auto.command,
      args: shellArgs(auto.command),
      label: auto.label,
      source: shellSource(auto.command)
    };
  }

  const cmd = process.env.ComSpec || "cmd.exe";
  return { command: cmd, args: ["/K"], label: "Command Prompt", source: "cmd" };
}

export function startTerminalProcess(input: { shell: TerminalShellInfo; cwd?: string; cols?: number; rows?: number }): TerminalProcess {
  const cwd = resolveCwd(input.cwd);
  const pty = spawnPty(input.shell.command, input.shell.args, {
    name: "xterm-256color",
    cols: input.cols ?? 80,
    rows: input.rows ?? 24,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1"
    }
  });
  return {
    id: crypto.randomUUID(),
    shell: input.shell,
    cwd,
    startedAt: new Date().toISOString(),
    pty
  };
}

export function stopTerminalProcess(terminal: TerminalProcess): void {
  terminal.pty.kill();
}

export function resizeTerminalProcess(terminal: TerminalProcess, cols: number, rows: number): void {
  terminal.pty.resize(cols, rows);
}

function resolveCwd(candidate?: string): string {
  const value = candidate?.trim();
  if (value && existsSync(value)) return value;
  return process.cwd();
}

function shellArgs(command: string): string[] {
  const basename = path.basename(command).toLowerCase();
  if (basename === "bash.exe" || basename === "bash") return ["--login", "-i"];
  if (basename === "powershell.exe" || basename === "powershell" || basename === "pwsh.exe" || basename === "pwsh") return ["-NoLogo", "-NoExit"];
  if (basename === "cmd.exe" || basename === "cmd") return ["/K"];
  return [];
}

function shellSource(command: string): TerminalShellInfo["source"] {
  const basename = path.basename(command).toLowerCase();
  if (basename === "nu.exe" || basename === "nu") return "nu";
  if (basename === "bash.exe" || basename === "bash") return "git-bash";
  if (basename === "powershell.exe" || basename === "powershell" || basename === "pwsh.exe" || basename === "pwsh") return "powershell";
  return "cmd";
}
