/**
 * Classifies a Markdown link/image destination emitted by a model into what the
 * chat can actually do with it.
 *
 * The rendering contract in the system prompt asks models for plain GFM: web
 * URLs as `[label](https://…)`, local files as `[app.py](/abs/path/app.py:12)`,
 * and local images as `![alt](/abs/path.png)`. Markdown itself carries no notion
 * of "this destination is a file on this machine", so the distinction has to be
 * recovered here from the destination's shape.
 *
 * Order matters: a Windows destination like `C:/Users/x/a.ts` parses as a URL
 * with scheme `c`, so every path shape is tested before anything URL-aware runs.
 */

import { defaultUrlTransform } from "react-markdown";

export type LocalFileCategory =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "code"
  | "data"
  | "other";

export type MessageLinkTarget =
  | { kind: "external"; href: string }
  | { kind: "local-image"; path: string; line?: number }
  | { kind: "local-file"; path: string; line?: number }
  | { kind: "plain"; href: string };

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]/;
const POSIX_ABSOLUTE = /^\//;
const HOME_ABSOLUTE = /^~(?=[\\/])/;
const EXTERNAL_SCHEME = /^(?:https?|mailto):/i;
// `file:` is deliberately absent: the prompt tells models not to emit it, and
// accepting it would mean guessing at host/percent-encoding rules for a form we
// never ask for.
const ANY_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg", "ico"
]);

const CATEGORY_BY_EXTENSION = new Map<string, LocalFileCategory>([
  ...asEntries("document", "doc", "docx", "pdf", "rtf", "odt", "pages", "txt", "md", "markdown", "epub"),
  ...asEntries("spreadsheet", "xls", "xlsx", "xlsm", "csv", "tsv", "ods", "numbers"),
  ...asEntries("presentation", "ppt", "pptx", "odp", "key"),
  ...asEntries("code", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "ps1", "sql", "css", "scss", "html", "vue", "svelte", "lua", "r", "pl", "dart", "scala", "ex", "exs"),
  ...asEntries("data", "json", "yaml", "yml", "toml", "xml", "ini", "env", "log", "ndjson", "parquet", "db", "sqlite", "zip", "tar", "gz", "tgz", "rar", "7z")
]);

function asEntries(category: LocalFileCategory, ...extensions: string[]): Array<[string, LocalFileCategory]> {
  return extensions.map((extension) => [extension, category]);
}

/**
 * `![alt](…)` and `[label](…)` differ only in whether a local target is worth
 * displaying inline, so both funnel through here and the caller decides.
 */
export function classifyMessageLink(href: string | null | undefined): MessageLinkTarget {
  const raw = typeof href === "string" ? href.trim() : "";
  if (!raw) return { kind: "plain", href: "" };

  const localPath = readLocalPath(raw);
  if (localPath) {
    // Split before decoding: an encoded colon inside a real filename must not
    // be mistaken for the line-number separator once it turns back into `:`.
    const { path: encodedPath, line } = splitLineSuffix(localPath);
    const filePath = decodeLocalPath(encodedPath);
    const kind = isImagePath(filePath) ? "local-image" : "local-file";
    return line === undefined ? { kind, path: filePath } : { kind, path: filePath, line };
  }

  if (EXTERNAL_SCHEME.test(raw)) return { kind: "external", href: raw };
  // Anchors and in-document references stay ordinary links; anything else with a
  // scheme we do not recognise is rendered as inert text rather than guessed at.
  return { kind: "plain", href: raw.startsWith("#") ? raw : "" };
}

/**
 * Returns the destination as a local filesystem path, or null when it is not one.
 * A leading `~/` is kept verbatim; the main process owns home expansion so the
 * renderer never has to know the user's home directory.
 */
function readLocalPath(value: string): string | null {
  if (WINDOWS_DRIVE_ABSOLUTE.test(value) || WINDOWS_UNC.test(value)) return value;
  if (HOME_ABSOLUTE.test(value)) return value;
  // A protocol-relative URL (`//example.com/a.png`) also starts with a slash,
  // and is a network target rather than a path.
  if (POSIX_ABSOLUTE.test(value) && !value.startsWith("//")) return value;
  if (ANY_SCHEME.test(value)) return null;
  return null;
}

/**
 * Strips the optional `:line` (and `:line:column`) suffix the prompt allows on
 * file links. The drive colon in `C:\src\a.ts` is never a line number, so a
 * candidate that would leave behind only a drive letter is rejected.
 */
function splitLineSuffix(value: string): { path: string; line?: number } {
  const match = /^(.*?):(\d{1,9})(?::\d{1,9})?$/.exec(value);
  if (!match) return { path: value };
  const [, head, lineText] = match;
  // A bare drive letter means the colon was `C:` rather than a line separator.
  if (!head || /^[A-Za-z]$/.test(head)) return { path: value };
  const line = Number.parseInt(lineText, 10);
  return line > 0 ? { path: head, line } : { path: value };
}

/**
 * Markdown destinations reach the renderer percent-encoded: the mdast-to-hast
 * step normalizes every URI, so `<C:/My Work/a.ts>` arrives as `C:/My%20Work/a.ts`.
 * A literal `%` in a real filename is encoded to `%25` by that same step, so
 * decoding restores the true path rather than corrupting it.
 */
function decodeLocalPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A destination containing a stray `%` that is not a valid escape.
    return value;
  }
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(filePath));
}

export function fileCategory(filePath: string): LocalFileCategory {
  return CATEGORY_BY_EXTENSION.get(fileExtension(filePath)) ?? "other";
}

/**
 * The badge text on a file chip. Long extensions would blow out the chip's
 * fixed leading slot, so they fall back to a generic mark.
 */
export function fileBadge(filePath: string, isDirectory = false): string {
  if (isDirectory) return "DIR";
  const extension = fileExtension(filePath);
  if (!extension || extension.length > 4) return "FILE";
  return extension.toUpperCase();
}

/** The `:12` suffix drawn after a chip's name. */
export function fileLineLabel(line: number | undefined): string {
  return line === undefined ? "" : `:${line}`;
}

export function fileExtension(filePath: string): string {
  const name = fileName(filePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function fileName(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator === -1 ? trimmed : trimmed.slice(separator + 1);
}

export function fileDirectory(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separator <= 0 ? "" : trimmed.slice(0, separator);
}

/**
 * Chromium resolves this against the renderer's own origin unless it is given a
 * scheme it can route, so local images are served over Jasmine's own protocol.
 * Encoding each segment keeps spaces, `#`, and `?` inside the path instead of
 * letting them terminate it.
 */
export function localFileSrc(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const withRoot = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `jasmine-file://local${withRoot.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * react-markdown's default transform drops any destination whose leading
 * `scheme:` is not web-safe, which silently deletes every Windows drive path
 * (`C:/Users/…` reads as scheme `c`). Local paths are recognised first and
 * passed through untouched; everything else keeps the library's sanitizer.
 */
export function messageUrlTransform(url: string): string {
  if (readLocalPath(url.trim())) return url;
  return defaultUrlTransform(url);
}
