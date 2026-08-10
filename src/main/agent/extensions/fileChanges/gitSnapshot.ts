import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { deflate, inflate } from "node:zlib";
import { promisify } from "node:util";
import type { FileContentKind, FileVersionMetadata } from "./schema.js";
import type { FileContentRedactionPredicate, FileRedactionPredicate } from "./redaction.js";
import { containsHighConfidenceSecret, isDefaultSensitivePath } from "./redaction.js";

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

export interface SnapshotRepository {
  directory: string;
  gitDirectory: string;
  hooksDirectory: string;
  attributesFile: string;
}

export interface SnapshotFile {
  path: string;
  absolutePath: string;
  metadata: FileVersionMetadata;
  kind: FileContentKind;
  mediaType?: string;
  redacted: boolean;
  contentAvailable: boolean;
  contentOmitted: boolean;
  contentOmittedReason?: "max-content-bytes" | "max-captured-content-bytes" | "max-run-captured-content-bytes";
  content: Buffer | null;
}

export interface RootSnapshot {
  files: Map<string, SnapshotFile>;
  complete: boolean;
  issues: SnapshotLimitIssue[];
  capturedContentBytes: number;
}

export interface SnapshotOptions {
  indexName: string;
  shouldRedact?: FileRedactionPredicate;
  shouldRedactContent?: FileContentRedactionPredicate;
  includeRelativePaths?: readonly string[];
  maxFiles: number;
  maxTotalBytes: number;
  maxContentBytes: number;
  maxCapturedContentBytes: number;
  capturedContentIssueCode?: "max-captured-content-bytes" | "max-run-captured-content-bytes";
  capturedContentIssueLimit?: number;
  warnings: string[];
}

export interface SnapshotLimitIssue {
  code: "max-files" | "max-total-bytes" | "read-error" | "unsupported-entry" | "excluded-root";
  path?: string;
  message: string;
}

interface SnapshotFileRead {
  sha256: string;
  size: number;
  sample: Buffer;
  content: Buffer | null;
  secretDetected: boolean;
  omittedBy?: "max-content-bytes" | "max-captured-content-bytes";
}

interface GitOutput {
  stdout: Buffer;
  stdoutByteSize: number;
  stdoutTruncated: boolean;
}

interface WalkedFile {
  path: string;
  absolutePath: string;
  mode: string;
  symlink: boolean;
  size: number;
}

interface WalkResult {
  files: WalkedFile[];
  complete: boolean;
  issues: SnapshotLimitIssue[];
}

export async function initializeSnapshotRepository(directory: string): Promise<SnapshotRepository> {
  const gitDirectory = path.join(directory, "repo.git");
  const hooksDirectory = path.join(directory, "hooks-disabled");
  const attributesFile = path.join(directory, "attributes-disabled");
  await mkdir(hooksDirectory, { recursive: true });
  await writeFile(attributesFile, "", { flag: "wx" });
  const repository = { directory, gitDirectory, hooksDirectory, attributesFile };
  try {
    await runGitProcess(repository, ["init", "--bare", "--quiet", "--object-format=sha1", gitDirectory]);
  } catch {
    // Older Git versions predate --object-format and only support SHA-1.
    await rm(gitDirectory, { recursive: true, force: true });
    await runGitProcess(repository, ["init", "--bare", "--quiet", gitDirectory], {
      env: { GIT_DEFAULT_HASH: "sha1" }
    });
  }
  return repository;
}

export async function removeSnapshotRepository(repository: SnapshotRepository | null): Promise<void> {
  if (!repository) return;
  await rm(repository.directory, { recursive: true, force: true });
}

export async function snapshotRoot(
  _repository: SnapshotRepository | null,
  root: string,
  options: SnapshotOptions
): Promise<RootSnapshot> {
  const files = new Map<string, SnapshotFile>();
  let complete = true;
  const issues: SnapshotLimitIssue[] = [];
  let capturedContentBytes = 0;
  if (!isExcludedAbsolutePath(root)) {
    if (!options.includeRelativePaths) {
      throw new Error("Full-root snapshots are disabled; explicit file paths are required.");
    }
    const walked = await walkExactFiles(root, options.includeRelativePaths, options.maxFiles, options.warnings);
    complete = walked.complete;
    issues.push(...walked.issues);
    let processedBytes = 0;
    for (const file of walked.files) {
      try {
        const pathRedacted = await shouldRedactFile(root, file, options.shouldRedact, options.warnings);
        const read = await readSnapshotFile(
          file,
          pathRedacted ? 0 : options.maxContentBytes,
          pathRedacted ? 0 : Math.max(0, options.maxCapturedContentBytes - capturedContentBytes),
          Math.max(0, options.maxTotalBytes - processedBytes)
        );
        const classification = classifyContent(read.content ?? read.sample);
        const contentRedacted = !pathRedacted
          && !file.symlink
          && (read.secretDetected || await shouldRedactFileContent(
              root,
              file,
              read.content ?? read.sample,
              read.content === null && read.size > read.sample.byteLength,
              options.shouldRedactContent,
              options.warnings
            ));
        const redacted = pathRedacted || contentRedacted;
        const retainsContent = !redacted
          && !file.symlink
          && read.content !== null
          && classification.kind !== "other";
        const omittedReason = !redacted && !file.symlink && read.omittedBy
          ? read.omittedBy === "max-captured-content-bytes"
            ? options.capturedContentIssueCode ?? read.omittedBy
            : read.omittedBy
          : undefined;
        files.set(file.path, {
          path: file.path,
          absolutePath: file.absolutePath,
          metadata: {
            sha256: read.sha256,
            size: read.size,
            mode: file.mode
          },
          kind: file.symlink ? "other" : classification.kind,
          ...(file.symlink || !classification.mediaType ? {} : { mediaType: classification.mediaType }),
          redacted,
          contentAvailable: retainsContent,
          contentOmitted: Boolean(omittedReason),
          ...(omittedReason ? { contentOmittedReason: omittedReason } : {}),
          content: retainsContent ? read.content : null
        });
        processedBytes += read.size;
        if (retainsContent) capturedContentBytes += read.size;
      } catch (error) {
        if (error instanceof SnapshotTotalBytesError) {
          const issue = limitIssue("max-total-bytes", root, options.maxTotalBytes);
          issues.push(issue);
          options.warnings.push(issue.message);
          complete = false;
          break;
        }
        const issue = filesystemIssue("read-error", file.absolutePath, `Could not snapshot ${file.absolutePath}: ${errorMessage(error)}`);
        issues.push(issue);
        options.warnings.push(issue.message);
        complete = false;
      }
    }
  } else {
    const issue = filesystemIssue("excluded-root", root, `Root is excluded by file-change policy: ${root}`);
    issues.push(issue);
    options.warnings.push(issue.message);
    complete = false;
  }

  return {
    files,
    complete,
    issues: uniqueIssues(issues),
    capturedContentBytes
  };
}

export async function listChangedPaths(
  before: RootSnapshot,
  after: RootSnapshot
): Promise<Array<{ status: "added" | "modified" | "deleted"; path: string }>> {
  const changes: Array<{ status: "added" | "modified" | "deleted"; path: string }> = [];
  const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort(stableCompare);
  for (const filePath of paths) {
    const beforeFile = before.files.get(filePath);
    const afterFile = after.files.get(filePath);
    if (!beforeFile && afterFile) {
      changes.push({ status: "added", path: filePath });
    } else if (beforeFile && !afterFile) {
      changes.push({ status: "deleted", path: filePath });
    } else if (beforeFile && afterFile && !sameIdentity(beforeFile, afterFile)) {
      changes.push({ status: "modified", path: filePath });
    }
  }
  return changes;
}

export interface UnifiedDiffInput {
  path: string;
  before: SnapshotFile | null;
  after: SnapshotFile | null;
}

export interface UnifiedDiffOutput {
  buffer: Buffer;
  byteSize: number;
  truncated: boolean;
}

export async function createUnifiedDiffs(
  repository: SnapshotRepository,
  inputs: readonly UnifiedDiffInput[],
  indexName: string,
  byteLimit: number
): Promise<Map<string, UnifiedDiffOutput>> {
  if (inputs.length === 0) return new Map();
  const synthetic = inputs.map((input, index) => ({
    ...input,
    syntheticPath: `.pi-file-changes-diff/${String(index).padStart(8, "0")}`
  }));
  const beforeTree = await writeDiffTree(repository, `${indexName}-before`, synthetic, "before");
  const afterTree = await writeDiffTree(repository, `${indexName}-after`, synthetic, "after");
  const outputPath = path.join(repository.directory, `${indexName}.patch`);
  await runGit(repository, [
    "-c",
    "core.quotePath=false",
    "diff",
    `--output=${outputPath}`,
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--text",
    "--unified=3",
    "--no-renames",
    beforeTree,
    afterTree
  ]);
  try {
    return await parseBatchDiff(outputPath, synthetic, byteLimit);
  } finally {
    await rm(outputPath, { force: true });
  }
}

async function writeDiffTree(
  repository: SnapshotRepository,
  indexName: string,
  inputs: ReadonlyArray<UnifiedDiffInput & { syntheticPath: string }>,
  side: "before" | "after"
): Promise<string> {
  const gitEnvironment = {
    GIT_DIR: repository.gitDirectory,
    GIT_INDEX_FILE: path.join(repository.directory, `${indexName}.index`)
  };
  await runGitProcess(repository, ["read-tree", "--empty"], { env: gitEnvironment });
  const records: Buffer[] = [];
  for (const input of inputs) {
    const file = input[side];
    if (!file) continue;
    if (!file.contentAvailable || file.content === null) {
      throw new Error(`Cannot build a diff tree without retained content for ${file.absolutePath}.`);
    }
    const oid = await writeVerifiedLooseBlob(repository.gitDirectory, file.content);
    records.push(
      Buffer.from(`${file.metadata.mode} ${oid}\t`, "utf8"),
      Buffer.from(input.syntheticPath, "utf8"),
      Buffer.from([0])
    );
  }
  if (records.length > 0) {
    await runGitProcess(repository, ["update-index", "-z", "--index-info"], {
      env: gitEnvironment,
      input: Buffer.concat(records)
    });
  }
  const tree = await runGitProcess(repository, ["write-tree"], { env: gitEnvironment });
  return tree.stdout.toString("utf8").trim();
}

async function parseBatchDiff(
  patchPath: string,
  inputs: ReadonlyArray<UnifiedDiffInput & { syntheticPath: string }>,
  byteLimit: number
): Promise<Map<string, UnifiedDiffOutput>> {
  const bySyntheticPath = new Map(inputs.map((input) => [input.syntheticPath, input]));
  const outputs = new Map<string, UnifiedDiffOutput>();
  const marker = Buffer.from("\ndiff --git a/.pi-file-changes-diff/", "utf8");
  let pending = Buffer.alloc(0);
  const stream = createReadStream(patchPath, { highWaterMark: 4 * 1024 * 1024 });
  try {
    for await (const rawChunk of stream) {
      pending = Buffer.concat([pending, Buffer.from(rawChunk)]);
      while (true) {
        const nextMarker = pending.indexOf(marker, 1);
        if (nextMarker < 0) break;
        materializePatch(pending.subarray(0, nextMarker + 1), bySyntheticPath, outputs, byteLimit);
        pending = pending.subarray(nextMarker + 1);
      }
    }
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
  if (pending.length > 0) materializePatch(pending, bySyntheticPath, outputs, byteLimit);
  return outputs;
}

function materializePatch(
  patch: Buffer,
  inputs: Map<string, UnifiedDiffInput & { syntheticPath: string }>,
  outputs: Map<string, UnifiedDiffOutput>,
  byteLimit: number
): void {
  const headerEnd = patch.indexOf(0x0a);
  const header = patch.subarray(0, headerEnd < 0 ? patch.length : headerEnd).toString("utf8");
  const match = /^diff --git a\/(\.pi-file-changes-diff\/\d+) b\/\1$/.exec(header);
  if (!match) throw new Error(`Could not parse batched Git diff header: ${header}`);
  const syntheticPath = match[1];
  const input = inputs.get(syntheticPath);
  if (!input) throw new Error(`Batched Git diff referenced an unknown synthetic path: ${syntheticPath}`);
  let text = patch.toString("utf8");
  const beforePath = formatPatchPath("a/", input.path);
  const afterPath = formatPatchPath("b/", input.path);
  text = text.replace(
    `diff --git a/${syntheticPath} b/${syntheticPath}`,
    `diff --git ${beforePath} ${afterPath}`
  );
  text = text.replace(`--- a/${syntheticPath}\n`, `--- ${beforePath}\n`);
  text = text.replace(`+++ b/${syntheticPath}\n`, `+++ ${afterPath}\n`);
  const rendered = Buffer.from(text, "utf8");
  outputs.set(input.path, {
    buffer: rendered.subarray(0, Math.min(rendered.byteLength, byteLimit + 4)),
    byteSize: rendered.byteLength,
    truncated: rendered.byteLength > byteLimit
  });
}

function formatPatchPath(prefix: "a/" | "b/", filePath: string): string {
  const value = `${prefix}${filePath}`;
  return /[\0-\x20"\\\x7f]/.test(value) ? JSON.stringify(value) : value;
}

export function isExcludedRelativePath(relativePath: string): boolean {
  const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index].toLowerCase();
    if (segment === ".git" || segment === "node_modules") return true;
    if (segment === ".pi" && segments[index + 1]?.toLowerCase() === "file-changes") return true;
  }
  return false;
}

export function isExcludedAbsolutePath(absolutePath: string): boolean {
  const parsed = path.parse(path.resolve(absolutePath));
  const relative = path.resolve(absolutePath).slice(parsed.root.length);
  return isExcludedRelativePath(relative);
}

async function walkExactFiles(
  root: string,
  relativePaths: readonly string[],
  maxFiles: number,
  warnings: string[]
): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const issues: SnapshotLimitIssue[] = [];
  for (const rawPath of [...new Set(relativePaths)].sort(stableCompare)) {
    const relativePath = rawPath.replace(/\\/g, "/");
    if (!relativePath || isExcludedRelativePath(relativePath)) continue;
    const absolutePath = path.resolve(root, ...relativePath.split("/"));
    if (!isPathInside(root, absolutePath)) {
      const issue = filesystemIssue("unsupported-entry", absolutePath, `Exact-file snapshot path escapes its root: ${absolutePath}`);
      warnings.push(issue.message);
      issues.push(issue);
      continue;
    }
    let info;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const issue = filesystemIssue("read-error", absolutePath, `Could not inspect ${absolutePath}: ${errorMessage(error)}`);
        warnings.push(issue.message);
        issues.push(issue);
      }
      continue;
    }
    if (!info.isFile() && !info.isSymbolicLink()) {
      const issue = filesystemIssue("unsupported-entry", absolutePath, `Exact-file snapshot target is not a file: ${absolutePath}`);
      warnings.push(issue.message);
      issues.push(issue);
      continue;
    }
    if (files.length >= maxFiles) {
      const issue = limitIssue("max-files", root, maxFiles);
      issues.push(issue);
      warnings.push(issue.message);
      return { files, complete: false, issues: uniqueIssues(issues) };
    }
    files.push({
      path: relativePath,
      absolutePath,
      mode: info.isSymbolicLink()
        ? "120000"
        : process.platform === "win32" || (info.mode & 0o111) === 0
          ? "100644"
          : "100755",
      symlink: info.isSymbolicLink(),
      size: info.size
    });
  }
  return {
    files,
    complete: !issues.some((issue) => issue.code === "read-error" || issue.code === "unsupported-entry"),
    issues: uniqueIssues(issues)
  };
}

async function readSnapshotFile(
  file: WalkedFile,
  maxContentBytes: number,
  remainingCapturedContentBytes: number,
  remainingTotalBytes: number
): Promise<SnapshotFileRead> {
  if (file.symlink) {
    const content = Buffer.from(await readlink(file.absolutePath), "utf8");
    if (content.byteLength > remainingTotalBytes) throw new SnapshotTotalBytesError();
    return {
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
      sample: content.subarray(0, 64 * 1024),
      content: content.byteLength <= maxContentBytes && content.byteLength <= remainingCapturedContentBytes ? content : null,
      secretDetected: false,
      ...(content.byteLength > maxContentBytes
        ? { omittedBy: "max-content-bytes" as const }
        : content.byteLength > remainingCapturedContentBytes
          ? { omittedBy: "max-captured-content-bytes" as const }
          : {})
    };
  }

  const hash = createHash("sha256");
  const sampleChunks: Buffer[] = [];
  const contentChunks: Buffer[] = [];
  let sampleBytes = 0;
  let size = 0;
  let retainContent = file.size <= maxContentBytes && file.size <= remainingCapturedContentBytes;
  let omittedBy: SnapshotFileRead["omittedBy"] = file.size > remainingCapturedContentBytes
    && remainingCapturedContentBytes <= maxContentBytes
    ? "max-captured-content-bytes"
    : file.size > maxContentBytes
      ? "max-content-bytes"
      : undefined;
  const secretDecoder = new TextDecoder("utf-8");
  let secretWindow = "";
  let secretDetected = false;

  const stream = createReadStream(file.absolutePath);
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.from(rawChunk);
      if (size + chunk.byteLength > remainingTotalBytes) {
        stream.destroy();
        throw new SnapshotTotalBytesError();
      }
      hash.update(chunk);
      size += chunk.byteLength;
      if (!secretDetected) {
        const decoded = secretDecoder.decode(chunk, { stream: true });
        const scanWindow = `${secretWindow}${decoded}`;
        secretDetected = containsHighConfidenceSecret(Buffer.from(scanWindow, "utf8"));
        secretWindow = scanWindow.slice(-8192);
      }
      if (sampleBytes < 64 * 1024) {
        const remainingSample = 64 * 1024 - sampleBytes;
        const sample = chunk.byteLength <= remainingSample ? chunk : chunk.subarray(0, remainingSample);
        sampleChunks.push(sample);
        sampleBytes += sample.byteLength;
      }
      if (retainContent && size <= maxContentBytes && size <= remainingCapturedContentBytes) {
        contentChunks.push(chunk);
      } else if (retainContent) {
        retainContent = false;
        contentChunks.length = 0;
        omittedBy = size > remainingCapturedContentBytes && remainingCapturedContentBytes <= maxContentBytes
          ? "max-captured-content-bytes"
          : "max-content-bytes";
      }
    }
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
  if (!secretDetected) {
    const finalWindow = `${secretWindow}${secretDecoder.decode()}`;
    secretDetected = containsHighConfidenceSecret(Buffer.from(finalWindow, "utf8"));
  }

  return {
    sha256: hash.digest("hex"),
    size,
    sample: Buffer.concat(sampleChunks),
    content: retainContent ? Buffer.concat(contentChunks) : null,
    secretDetected,
    ...(omittedBy ? { omittedBy } : {})
  };
}

class SnapshotTotalBytesError extends Error {}

function limitIssue(code: "max-files" | "max-total-bytes", root: string, limit: number): SnapshotLimitIssue {
  return {
    code,
    message: code === "max-files"
      ? `Partial file-change snapshot for ${root}: maximum file count ${limit} reached.`
      : `Partial file-change snapshot for ${root}: maximum total bytes ${limit} reached.`
  };
}

function filesystemIssue(
  code: "read-error" | "unsupported-entry" | "excluded-root",
  issuePath: string,
  message: string
): SnapshotLimitIssue {
  return { code, path: issuePath, message };
}

function uniqueIssues(issues: SnapshotLimitIssue[]): SnapshotLimitIssue[] {
  const byKey = new Map<string, SnapshotLimitIssue>();
  for (const issue of issues) byKey.set(`${issue.code}\0${issue.path ?? ""}\0${issue.message}`, issue);
  return [...byKey.values()].sort((left, right) => stableCompare(left.code, right.code)
    || stableCompare(left.path ?? "", right.path ?? "")
    || stableCompare(left.message, right.message));
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function shouldRedactFile(
  root: string,
  file: WalkedFile,
  predicate: FileRedactionPredicate | undefined,
  warnings: string[]
): Promise<boolean> {
  if (isDefaultSensitivePath(file.path)) return true;
  if (!predicate) return false;
  try {
    return Boolean(await predicate({
      root,
      path: file.path,
      absolutePath: file.absolutePath
    }));
  } catch (error) {
    warnings.push(`Redaction predicate failed closed for ${file.absolutePath}: ${errorMessage(error)}`);
    return true;
  }
}

async function shouldRedactFileContent(
  root: string,
  file: WalkedFile,
  content: Buffer,
  contentTruncated: boolean,
  predicate: FileContentRedactionPredicate | undefined,
  warnings: string[]
): Promise<boolean> {
  if (containsHighConfidenceSecret(content)) return true;
  if (!predicate) return false;
  try {
    return Boolean(await predicate({
      root,
      path: file.path,
      absolutePath: file.absolutePath,
      content,
      contentTruncated
    }));
  } catch (error) {
    warnings.push(`Content redaction predicate failed closed for ${file.absolutePath}: ${errorMessage(error)}`);
    return true;
  }
}

function sameIdentity(before: SnapshotFile, after: SnapshotFile): boolean {
  return before.metadata.sha256 === after.metadata.sha256
    && before.metadata.size === after.metadata.size
    && before.metadata.mode === after.metadata.mode;
}

async function writeVerifiedLooseBlob(gitDirectory: string, content: Buffer): Promise<string> {
  const header = Buffer.from(`blob ${content.byteLength}\0`, "utf8");
  const object = Buffer.concat([header, content]);
  const oid = createHash("sha1").update(object).digest("hex");
  const objectDirectory = path.join(gitDirectory, "objects", oid.slice(0, 2));
  const objectPath = path.join(objectDirectory, oid.slice(2));
  await mkdir(objectDirectory, { recursive: true });
  const compressed = await deflateAsync(object);
  try {
    await writeFile(objectPath, compressed, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await inflateAsync(await readFile(objectPath));
    if (!existing.equals(object)) {
      throw new Error(`Git object collision or corruption detected for ${oid}; snapshot stopped fail-closed.`);
    }
  }
  return oid;
}

function classifyContent(content: Buffer): { kind: FileContentKind; mediaType?: string } {
  const mediaType = detectImageMediaType(content);
  if (mediaType) return { kind: "image", mediaType };
  if (content.includes(0)) return { kind: "other" };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return { kind: "text" };
  } catch {
    return { kind: "other" };
  }
}

function detectImageMediaType(content: Buffer): string | undefined {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length >= 6 && (content.subarray(0, 6).toString("ascii") === "GIF87a" || content.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (content.length >= 2 && content[0] === 0x42 && content[1] === 0x4d) return "image/bmp";
  if (content.length >= 4 && content[0] === 0 && content[1] === 0 && content[2] === 1 && content[3] === 0) return "image/x-icon";
  return undefined;
}

async function runGit(
  repository: SnapshotRepository,
  args: string[],
  options: { collectLimit?: number; input?: Buffer } = {}
): Promise<GitOutput> {
  return runGitProcess(repository, ["--git-dir", repository.gitDirectory, ...args], options);
}

async function runGitProcess(
  repository: SnapshotRepository,
  args: string[],
  options: {
    env?: Record<string, string>;
    input?: Buffer;
    collectLimit?: number;
  } = {}
): Promise<GitOutput> {
  return runProcess("git", [
    "--no-optional-locks",
    "-c",
    `core.hooksPath=${repository.hooksDirectory}`,
    "-c",
    "diff.external=",
    "-c",
    `core.attributesFile=${repository.attributesFile}`,
    ...args
  ], {
    ...options,
    isolateGitEnvironment: true
  });
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    input?: Buffer;
    collectLimit?: number;
    isolateGitEnvironment?: boolean;
  } = {}
): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const inheritedEnvironment = options.isolateGitEnvironment
      ? isolatedGitEnvironment()
      : { ...process.env };
    const child = spawn(command, args, {
      env: { ...inheritedEnvironment, ...options.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutByteSize = 0;
    let collectedStdoutBytes = 0;
    let stderrByteSize = 0;
    const collectLimit = options.collectLimit ?? Number.POSITIVE_INFINITY;

    child.stdout.on("data", (raw: Buffer) => {
      const chunk = Buffer.from(raw);
      stdoutByteSize += chunk.byteLength;
      const remaining = collectLimit - collectedStdoutBytes;
      if (remaining > 0) {
        const collected = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
        stdoutChunks.push(collected);
        collectedStdoutBytes += collected.byteLength;
      }
    });
    child.stderr.on("data", (raw: Buffer) => {
      const chunk = Buffer.from(raw);
      stderrByteSize += chunk.byteLength;
      if (stderrByteSize <= MAX_DIAGNOSTIC_BYTES) stderrChunks.push(chunk);
    });
    child.stdin.on("error", () => {
      // A failed Git process can close stdin before a large index payload has
      // finished writing. The exit handler below reports the authoritative
      // command error.
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code ?? "unknown"}): ${Buffer.concat(stderrChunks).toString("utf8").trim()}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stdoutByteSize,
        stdoutTruncated: stdoutByteSize > collectedStdoutBytes
      });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_ATTR_NOSYSTEM = "1";
  return environment;
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
