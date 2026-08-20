import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(packageRoot, "runtime", "linux-x64-glibc");
const descriptorPath = path.join(runtimeDir, "artifact.json");
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
if (descriptor.version !== 1 || descriptor.runtimeVersion !== "0.1.0" || descriptor.piVersion !== "0.84.2") {
  throw new Error("Runtime artifact descriptor version does not match the package");
}
const archivePath = path.join(runtimeDir, descriptor.archive);
const expectedSha256 = descriptor.archiveSha256;

if (await sha256(archivePath).catch(() => "") === expectedSha256) {
  process.stderr.write(`${JSON.stringify({ archive: descriptor.archive, status: "present" })}\n`);
} else {
  await fetchArchive();
}

async function fetchArchive() {
  const url = process.env.PI_REMOTE_RUNTIME_URL || descriptor.archiveUrl;
  if (typeof url !== "string" || !/^https:\/\//u.test(url)) {
    throw new Error("artifact.json must define an https archiveUrl (or set PI_REMOTE_RUNTIME_URL) so the runtime archive can be fetched.");
  }
  // Node's fetch ignores proxy environment variables unless NODE_USE_ENV_PROXY is enabled,
  // so re-exec through a proxied child when a corporate proxy is configured.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy && process.env.NODE_USE_ENV_PROXY !== "1") {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: "inherit",
      env: { ...process.env, NODE_USE_ENV_PROXY: "1" }
    });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
  process.stderr.write(`Fetching ${url}\n`);
  let response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (error) {
    process.stderr.write(`WARNING: could not download the runtime archive (${error instanceof Error ? error.message : String(error)}). Run \`npm run runtime:fetch\` when network access is available.\n`);
    process.exit(0);
  }
  if (!response.ok || !response.body) throw new Error(`Failed to download the runtime archive: HTTP ${response.status}`);
  await mkdir(runtimeDir, { recursive: true });
  const temporary = `${archivePath}.${process.pid}.tmp`;
  try {
    await pipeline(response.body, createWriteStream(temporary));
    const actual = await sha256(temporary);
    if (actual !== expectedSha256) {
      throw new Error(`Downloaded runtime archive SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
    }
    await renameWithRetry(temporary, archivePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  process.stderr.write(`${JSON.stringify({ archive: descriptor.archive, sha256: expectedSha256, status: "fetched" })}\n`);
}

async function renameWithRetry(source, target) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES" && error?.code !== "EBUSY" && error?.code !== "ENOENT") throw error;
      if (attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

async function sha256(filePath) {
  try {
    await access(filePath);
  } catch {
    return "";
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
