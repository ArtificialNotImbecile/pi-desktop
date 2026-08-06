import { opendir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileSearchRequest, FileSearchResult, PickedPath } from "../../shared/ipc.js";

const MAX_RESULTS = 20;
const MAX_VISITED = 5000;
const MAX_DEPTH = 6;
const SKIPPED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".tmp",
  ".venv",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "test-results"
]);

export async function searchWorkspaceFiles(request: FileSearchRequest, cwd = process.cwd()): Promise<FileSearchResult[]> {
  const query = request.query.trim();
  if (!query) return [];
  const root = path.resolve(request.cwd?.trim() || cwd);
  const maxResults = Math.min(Math.max(request.limit ?? MAX_RESULTS, 1), 50);
  const results: FileSearchResult[] = [];
  let visited = 0;

  async function visit(dir: string, depth: number): Promise<void> {
    if (visited >= MAX_VISITED || depth > MAX_DEPTH) return;
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    for await (const entry of handle) {
      if (visited >= MAX_VISITED) break;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await visit(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visited++;
      const filePath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(root, filePath));
      const score = scoreFile(query, entry.name, relativePath);
      if (score <= 0) continue;
      results.push({
        name: entry.name,
        path: filePath,
        relativePath,
        kind: "file",
        score
      });
    }
  }

  await visit(root, 0);
  return results
    .sort((a, b) => b.score - a.score || a.relativePath.length - b.relativePath.length || a.relativePath.localeCompare(b.relativePath))
    .slice(0, maxResults);
}

export async function pickedFileFromPath(filePath: string): Promise<PickedPath> {
  const resolved = expandPath(filePath);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) throw new Error("Selected path is not a file.");
  const mediaType = mediaTypeFromPath(resolved);
  const isImage = Boolean(mediaType?.startsWith("image/"));
  const previewDataUrl = isImage && mediaType ? await imagePreviewDataUrl(resolved, mediaType) : undefined;
  return { name: path.basename(resolved), path: resolved, kind: "file", mediaType, isImage, previewDataUrl };
}

function scoreFile(query: string, name: string, relativePath: string): number {
  const q = query.toLowerCase();
  const base = name.toLowerCase();
  const rel = relativePath.toLowerCase();
  if (base === q) return 1000;
  if (base.startsWith(q)) return 850 - base.length;
  if (base.includes(q)) return 650 - base.indexOf(q);
  if (rel.includes(q)) return 430 - rel.indexOf(q);
  const fuzzy = fuzzyScore(q, base) || fuzzyScore(q, rel);
  return fuzzy;
}

function fuzzyScore(query: string, value: string): number {
  let qi = 0;
  let last = -1;
  let score = 0;
  for (let i = 0; i < value.length && qi < query.length; i++) {
    if (value[i] !== query[qi]) continue;
    score += last === i - 1 ? 18 : 8;
    last = i;
    qi++;
  }
  return qi === query.length ? Math.max(1, score - value.length) : 0;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function expandPath(value: string): string {
  return path.resolve(value.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
}

async function imagePreviewDataUrl(filePath: string, mediaType: string): Promise<string | undefined> {
  try {
    const data = await readFile(filePath);
    return `data:${mediaType};base64,${data.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function mediaTypeFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return undefined;
}
