import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LocalFileDescription } from "../../shared/ipc.js";

/**
 * Path and URL reasoning behind the local files an assistant answer references.
 * Deliberately free of Electron imports so it can be exercised directly; the
 * Electron-facing wiring lives in `localFiles.ts`.
 */

export const LOCAL_FILE_SCHEME = "jasmine-file";

// Displayable in an <img>. A format Chromium cannot decode would only produce a
// broken image, so the renderer is told to fall back to a file chip instead.
const IMAGE_MEDIA_TYPES = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
  ["avif", "image/avif"],
  ["ico", "image/x-icon"],
  ["svg", "image/svg+xml"]
]);

// A rendered chat image is decoded in the renderer process. Past this size the
// cost of decoding outweighs the value of showing it inline, so the chip form
// is used instead.
export const MAX_INLINE_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * `jasmine-file://local/<encoded path>` — the fixed `local` host keeps the
 * scheme `standard`-compatible (a standard scheme requires a host) and leaves
 * room for other sources later without changing the URL shape.
 */
export function localPathFromRequestUrl(requestUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${LOCAL_FILE_SCHEME}:` || parsed.host !== "local") return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0")) return null;

  // A standard URL pathname carries a leading slash before a Windows drive
  // letter. The same normalizer also accepts that spelling when a model writes
  // it directly in Markdown.
  const candidate = normalizeLocalPathInput(decoded);
  const resolved = path.resolve(candidate);
  return path.isAbsolute(resolved) ? resolved : null;
}

export function imageMediaType(filePath: string): string | undefined {
  return IMAGE_MEDIA_TYPES.get(path.extname(filePath).replace(/^\./, "").toLowerCase());
}

export function expandLocalPath(value: string): string {
  const expandedHome = value.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(normalizeLocalPathInput(expandedHome));
}

function normalizeLocalPathInput(value: string): string {
  if (process.platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(value)) return value.slice(1);
  return value;
}

/**
 * Model output is untrusted input. Handing an arbitrary destination to the OS
 * would let a `javascript:`, `smb:`, or installer-registered scheme act with the
 * user's authority on a single click, so only the schemes the rendering
 * contract asks for are ever forwarded.
 */
export function isForwardableExternalUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length > 8_192) return false;
  try {
    const protocolName = new URL(rawUrl).protocol;
    return protocolName === "http:" || protocolName === "https:" || protocolName === "mailto:";
  } catch {
    return false;
  }
}

/**
 * Metadata only, never bytes: the renderer uses this to choose between an inline
 * image, a file chip, and a dead reference. A model naming a path that does not
 * exist is common enough that absence is a normal answer rather than an error.
 */
export async function describeLocalFiles(paths: string[]): Promise<LocalFileDescription[]> {
  const unique = Array.from(new Set(paths.map((value) => value.trim()).filter(Boolean)));
  return Promise.all(unique.map(async (requested) => describeLocalFile(requested)));
}

async function describeLocalFile(requested: string): Promise<LocalFileDescription> {
  const resolved = expandLocalPath(requested);
  const base: LocalFileDescription = {
    requestedPath: requested,
    path: resolved,
    name: path.basename(resolved) || resolved,
    exists: false,
    kind: "missing"
  };
  try {
    const info = await stat(resolved);
    if (info.isDirectory()) return { ...base, exists: true, kind: "directory" };
    if (!info.isFile()) return base;
    const mediaType = imageMediaType(resolved);
    return {
      ...base,
      exists: true,
      kind: "file",
      size: info.size,
      mediaType,
      // Oversized images stay files: the protocol would refuse to serve them,
      // and a chip is more useful than an image that never paints.
      isImage: Boolean(mediaType) && info.size <= MAX_INLINE_IMAGE_BYTES
    };
  } catch {
    return base;
  }
}
