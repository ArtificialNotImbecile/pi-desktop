import { app, BrowserWindow, clipboard, dialog, ipcMain, type OpenDialogOptions } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClipboardImagePasteRequest, ExecutablePickerKind, FileSearchRequest, FileSearchResult, PickedPath } from "../../shared/ipc.js";
import { clipboardTextSchema, executablePickerKindSchema, fileSearchRequestSchema } from "../../shared/schemas.js";
import { pickedFileFromPath, searchWorkspaceFiles } from "../services/fileSearch.js";
import type { IpcContext } from "./context.js";

export function registerDialogIpc(context: IpcContext): void {
  let fallbackClipboardText = "";
  let nativeTextClipboardAvailable: boolean | null = null;

  ipcMain.handle("dialog:searchFiles", async (_event, request: FileSearchRequest): Promise<FileSearchResult[]> => {
    const parsed = fileSearchRequestSchema.parse(request);
    if (parsed.projectId !== undefined) {
      if (parsed.projectId === null) return [];
      return searchWorkspaceFiles(parsed, context.getDatabase().getProjectCwd(parsed.projectId));
    }
    if (!parsed.cwd) return [];
    return searchWorkspaceFiles(parsed);
  });

  ipcMain.handle("dialog:pickFileFromPath", async (_event, filePath: string): Promise<PickedPath> => {
    return pickedFileFromPath(filePath);
  });

  ipcMain.handle("dialog:pickFile", async (event): Promise<PickedPath | null> => {
    if (process.env.JASMINE_E2E_PICK_FILE) {
      return pickedFileFromPath(process.env.JASMINE_E2E_PICK_FILE);
    }

    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Attach file",
      properties: ["openFile"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const picked = result.filePaths[0];
    return pickedFileFromPath(picked);
  });

  ipcMain.handle("dialog:pickClipboardImage", async (): Promise<PickedPath | null> => {
    if (process.env.JASMINE_E2E_CLIPBOARD_IMAGE) {
      return pickedFileFromPath(process.env.JASMINE_E2E_CLIPBOARD_IMAGE);
    }
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    return saveClipboardImageBuffer(image.toPNG(), "image/png");
  });

  ipcMain.handle("dialog:savePastedImage", async (_event, request: ClipboardImagePasteRequest): Promise<PickedPath> => {
    const data = request?.data;
    if (!(data instanceof ArrayBuffer)) {
      throw new Error("Invalid pasted image payload.");
    }
    const buffer = Buffer.from(new Uint8Array(data));
    if (buffer.length === 0) {
      throw new Error("Pasted image payload is empty.");
    }
    return saveClipboardImageBuffer(buffer, request.mimeType, request.name);
  });

  ipcMain.handle("clipboard:readText", async (): Promise<string> => {
    const text = clipboard.readText();
    if (text || nativeTextClipboardAvailable !== false) return text;
    return fallbackClipboardText;
  });

  ipcMain.handle("clipboard:writeText", async (_event, text: string): Promise<void> => {
    const parsed = clipboardTextSchema.parse(text);
    fallbackClipboardText = parsed;
    clipboard.writeText(parsed);
    nativeTextClipboardAvailable = clipboard.readText() === parsed;
  });

  ipcMain.handle("dialog:pickFolder", async (event, title?: string): Promise<PickedPath | null> => {
    if (process.env.JASMINE_E2E_PICK_FOLDER) {
      const picked = process.env.JASMINE_E2E_PICK_FOLDER;
      return { name: path.basename(picked), path: picked, kind: "folder" };
    }

    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : "Attach folder",
      properties: ["openDirectory"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const picked = result.filePaths[0];
    return { name: path.basename(picked), path: picked, kind: "folder" };
  });

  ipcMain.handle("dialog:pickSkillFolders", async (event): Promise<string[]> => {
    if (process.env.JASMINE_E2E_PICK_SKILL_FOLDERS) {
      return process.env.JASMINE_E2E_PICK_SKILL_FOLDERS.split(path.delimiter).filter(Boolean);
    }

    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Add skill folders",
      properties: ["openDirectory", "multiSelections"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("dialog:listExecutableDiscovery", async (_event, kind: unknown) => {
    const parsed = executablePickerKindSchema.parse(kind);
    const { listExecutableDiscovery } = await import("../services/executables.js");
    return listExecutableDiscovery(parsed);
  });

  ipcMain.handle("dialog:pickExecutable", async (event, kind: ExecutablePickerKind): Promise<string | null> => {
    const normalizedKind = kind === "terminal" ? "terminal" : "editor";
    const e2eValue = normalizedKind === "terminal" ? process.env.JASMINE_E2E_PICK_TERMINAL_SHELL : process.env.JASMINE_E2E_PICK_EDITOR;
    if (e2eValue) return e2eValue;

    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: normalizedKind === "terminal" ? "Choose terminal shell" : "Choose text editor",
      filters: process.platform === "win32"
        ? [{ name: "Applications and scripts", extensions: ["exe", "cmd", "bat", "ps1"] }]
        : undefined,
      properties: ["openFile"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("dialog:pickPromptTemplatePaths", async (event): Promise<string[]> => {
    if (process.env.JASMINE_E2E_PICK_PROMPT_TEMPLATE_PATHS) {
      return process.env.JASMINE_E2E_PICK_PROMPT_TEMPLATE_PATHS.split(path.delimiter).filter(Boolean);
    }

    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Add prompt template files or folders",
      filters: [{ name: "Markdown prompt templates", extensions: ["md"] }],
      properties: ["openFile", "openDirectory", "multiSelections"]
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
}

async function saveClipboardImageBuffer(buffer: Buffer, mimeType = "image/png", sourceName?: string): Promise<PickedPath> {
  const directory = path.join(app.getPath("userData"), "attachments", "clipboard");
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const extension = imageExtensionForMimeType(mimeType) ?? imageExtensionFromName(sourceName) ?? "png";
  const filePath = path.join(directory, `clipboard-${timestamp}-${randomUUID().slice(0, 8)}.${extension}`);
  await writeFile(filePath, buffer);
  return pickedFileFromPath(filePath);
}

function imageExtensionForMimeType(mimeType?: string): string | null {
  const normalized = mimeType?.toLowerCase().split(";")[0].trim();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/bmp") return "bmp";
  return null;
}

function imageExtensionFromName(name?: string): string | null {
  if (!name) return null;
  const extension = path.extname(name).toLowerCase().replace(/^\./, "");
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension) ? extension : null;
}
