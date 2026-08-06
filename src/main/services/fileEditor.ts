import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolveConfiguredExecutable, listExecutableDiscovery } from "./executables.js";

export async function openPathInEditor(input: {
  filePath: string;
  currentEditorPath?: string;
  saveEditorPath(editorPath: string): void;
  chooserTitle?: string;
}): Promise<{ editorPath?: string; openedPath: string }> {
  const editorPath = await resolveEditorPath(input.currentEditorPath, input.chooserTitle);
  if (editorPath) {
    input.saveEditorPath(editorPath);
    await launchEditor(editorPath, input.filePath);
  } else {
    await openWithSystemDefault(input.filePath);
  }
  return {
    editorPath,
    openedPath: input.filePath
  };
}

async function resolveEditorPath(currentEditorPath?: string, chooserTitle?: string): Promise<string | undefined> {
  const e2eEditorPath = process.env.JASMINE_E2E_EDITOR_PATH?.trim();
  if (e2eEditorPath) return e2eEditorPath;
  const configured = await resolveConfiguredExecutable("editor", currentEditorPath);
  if (configured) return configured.command;
  const detected = (await listExecutableDiscovery("editor")).auto;
  if (detected) return detected.command;

  const { dialog } = await import("electron");
  const result = await dialog.showOpenDialog({
    title: chooserTitle ?? "Choose a text editor for Jasmine files",
    properties: ["openFile"],
    filters: process.platform === "win32"
      ? [{ name: "Applications", extensions: ["exe", "cmd", "bat"] }, { name: "All files", extensions: ["*"] }]
      : [{ name: "Applications", extensions: ["*"] }]
  });
  return result.canceled ? undefined : result.filePaths[0];
}

async function launchEditor(editorPath: string, filePath: string): Promise<void> {
  const logPath = process.env.JASMINE_E2E_OPEN_EDITOR_LOG?.trim();
  if (logPath) {
    await appendFile(logPath, `${editorPath}\t${filePath}\n`, "utf8");
    return;
  }
  const child = spawn(editorPath, [filePath], {
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(editorPath)
  });
  child.unref();
}

async function openWithSystemDefault(filePath: string): Promise<void> {
  const { shell } = await import("electron");
  const error = await shell.openPath(filePath);
  if (error) {
    throw new Error(error);
  }
}
