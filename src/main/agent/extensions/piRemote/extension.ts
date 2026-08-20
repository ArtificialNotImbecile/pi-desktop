import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiRemoteError } from "./errors.js";
import { ProfileStore } from "./profiles.js";
import { ManagedRemoteRuntime } from "./runtime.js";

interface PendingHandoff {
  profile: string;
  cwd?: string;
}

export default function piRemoteExtension(pi: ExtensionAPI): void {
  let pending: PendingHandoff | undefined;
  const store = new ProfileStore();

  pi.registerCommand("remote", {
    description: "Exit this local Pi session and connect to an isolated managed Pi runtime",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/remote requires interactive TUI mode.", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current turn to finish or abort it before /remote.", "warning");
        return;
      }
      const parsed = parseRemoteArgs(args);
      if (!parsed.profile) {
        const profiles = await store.list();
        if (profiles.length === 0) {
          ctx.ui.notify("No remote profiles. Run `pi-remote profile add ...` first.", "warning");
          return;
        }
        const selected = await ctx.ui.select("Remote profile", profiles.map((profile) => profile.name));
        if (!selected) return;
        parsed.profile = selected;
      }
      await store.get(parsed.profile);
      pending = { profile: parsed.profile, ...(parsed.cwd ? { cwd: parsed.cwd } : {}) };
      ctx.ui.notify(`Handing off to remote profile ${parsed.profile}...`, "info");
      ctx.shutdown();
    }
  });

  pi.registerCommand("remote-doctor", {
    description: "Run read-only diagnostics for a pi-remote profile",
    handler: async (args, ctx) => {
      const profile = await store.get(args.trim());
      const report = await new ManagedRemoteRuntime().doctor(profile);
      const failed = report.checks.filter((check) => check.status === "fail");
      ctx.ui.notify(report.ok ? `${profile.name} is ready.` : `${profile.name}: ${failed.map((check) => check.message).join("; ")}`, report.ok ? "info" : "error");
    }
  });

  pi.registerCommand("remote-profiles", {
    description: "List configured pi-remote profiles",
    handler: async (_args, ctx) => {
      const profiles = await store.list();
      ctx.ui.notify(profiles.length ? profiles.map((profile) => `${profile.name} (${profile.sshHost})`).join("\n") : "No pi-remote profiles configured.", "info");
    }
  });

  pi.on("session_shutdown", async () => {
    const handoff = pending;
    pending = undefined;
    if (!handoff) return;
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    const args = [cliPath, "connect", handoff.profile, ...(handoff.cwd ? ["--cwd", handoff.cwd] : [])];
    const child = spawn(process.execPath, args, { stdio: "inherit", windowsHide: false });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
  });
}

export function parseRemoteArgs(value: string): PendingHandoff {
  const parts = parseCommandWords(value);
  let profile = "";
  let cwd: string | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part === "--cwd") {
      if (cwd !== undefined) throw remoteArgsError("--cwd may be specified only once.");
      cwd = parts[index + 1];
      if (!cwd) throw remoteArgsError("--cwd requires a non-empty path.");
      index += 1;
      continue;
    }
    if (part.startsWith("-")) throw remoteArgsError(`Unknown /remote option ${JSON.stringify(part)}.`);
    if (profile) throw remoteArgsError("/remote accepts at most one profile.");
    profile = part;
  }
  return { profile, ...(cwd ? { cwd } : {}) };
}

function parseCommandWords(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (const character of value) {
    if (escaping) {
      current += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else current += character;
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "\\") escaping = true;
      else current += character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (tokenStarted) parts.push(current);
      current = "";
      tokenStarted = false;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (character === "\\") {
      escaping = true;
      tokenStarted = true;
    } else {
      current += character;
      tokenStarted = true;
    }
  }
  if (quote || escaping) throw remoteArgsError("/remote contains an unterminated quote or escape.");
  if (tokenStarted) parts.push(current);
  return parts;
}

function remoteArgsError(message: string): PiRemoteError {
  return new PiRemoteError("remote-args-invalid", message, { phase: "session" });
}
