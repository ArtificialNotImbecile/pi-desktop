import { app, net, protocol, shell } from "electron";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LOCAL_FILE_SCHEME,
  MAX_INLINE_IMAGE_BYTES,
  expandLocalPath,
  imageMediaType,
  isForwardableExternalUrl,
  localPathFromRequestUrl
} from "./localFilePaths.js";

/**
 * Assistant answers reference files by absolute path. Chromium resolves a bare
 * path in `<img src>` against the renderer's own origin, so local media is
 * served over a dedicated scheme instead. Keeping it off `file://` means the
 * renderer never gets blanket filesystem read access, and lets every request go
 * through one place that decides what may be displayed.
 */

export { LOCAL_FILE_SCHEME, describeLocalFiles, isForwardableExternalUrl } from "./localFilePaths.js";

/**
 * Must run before `app.whenReady()`; Chromium locks its scheme registry at
 * startup. `standard` gives the scheme a normal origin so relative resolution
 * and caching behave, and `secure` keeps it from counting as mixed content
 * inside the app's own page.
 */
export function registerLocalFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_FILE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    }
  ]);
}

export function registerLocalFileProtocol(): void {
  protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    const filePath = localPathFromRequestUrl(request.url);
    if (!filePath) return new Response("Not found", { status: 404 });

    // Only image types are ever served. This scheme exists to paint pictures in
    // chat, not to be a general reader for anything on disk.
    const mediaType = imageMediaType(filePath);
    if (!mediaType) return new Response("Unsupported media type", { status: 415 });

    try {
      const info = await stat(filePath);
      if (!info.isFile()) return new Response("Not found", { status: 404 });
      if (info.size > MAX_INLINE_IMAGE_BYTES) return new Response("Too large", { status: 413 });
    } catch {
      return new Response("Not found", { status: 404 });
    }

    const response = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(response.headers);
    // Chromium sniffs `file://` responses loosely; pinning the type keeps a
    // local file from being interpreted as something other than an image.
    headers.set("Content-Type", mediaType);
    headers.set("X-Content-Type-Options", "nosniff");
    // An SVG is a document, not just pixels. Served without this it could reach
    // for network resources or run script if it ever left an <img> context.
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return new Response(response.body, { status: response.status, headers });
  });
}

export async function openLocalPath(requested: string): Promise<void> {
  const resolved = expandLocalPath(requested);
  const info = await stat(resolved);
  if (!info.isFile() && !info.isDirectory()) throw new Error("Path is not a file or folder.");
  const error = await shell.openPath(resolved);
  if (error) throw new Error(error);
}

export async function revealLocalPath(requested: string): Promise<void> {
  const resolved = expandLocalPath(requested);
  await stat(resolved);
  shell.showItemInFolder(resolved);
}

export async function openExternalUrl(rawUrl: string): Promise<void> {
  if (!isForwardableExternalUrl(rawUrl)) throw new Error("Refusing to open an unsupported link target.");
  await shell.openExternal(rawUrl);
}

/**
 * Every window in the app renders trusted local UI. A model-authored link that
 * opened a real BrowserWindow would inherit that window's preload and
 * privileges, so navigation stays inside the app and outward links are handed
 * to the OS browser instead.
 */
export function guardWindowNavigation(contents: Electron.WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isForwardableExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isAppNavigation(url)) return;
    event.preventDefault();
    if (isForwardableExternalUrl(url)) void shell.openExternal(url);
  });
}

function isAppNavigation(url: string): boolean {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl && url.startsWith(devServerUrl.replace(/\/$/, ""))) return true;
  if (!url.startsWith("file://")) return false;
  // Only the packaged renderer's own directory, not any file the OS can read.
  try {
    const parsed = new URL(url);
    const decoded = decodeURIComponent(parsed.pathname);
    const filePath = /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded;
    return path.resolve(filePath).startsWith(path.resolve(app.getAppPath()));
  } catch {
    return false;
  }
}
