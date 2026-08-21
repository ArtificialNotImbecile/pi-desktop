import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(packageRoot, "runtime", "linux-x64-glibc");
const descriptorPath = path.join(runtimeDir, "artifact.json");
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
if (descriptor.version !== 1 || descriptor.runtimeVersion !== "0.1.2" || descriptor.piVersion !== "0.84.2") {
  throw new Error("Runtime artifact descriptor version does not match the package");
}
const archivePath = path.join(runtimeDir, descriptor.archive);
await access(archivePath);
const actual = await sha256(archivePath);
if (actual !== descriptor.archiveSha256) throw new Error(`Runtime archive SHA-256 mismatch: ${actual}`);
await verifyTar(archivePath);
process.stderr.write(`${JSON.stringify({ archive: descriptor.archive, sha256: actual })}\n`);

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyTar(filePath) {
  const command = process.platform === "win32" ? "wsl.exe" : "tar";
  const args = process.platform === "win32"
    ? ["-d", process.env.PI_REMOTE_WSL_DISTRO || "Ubuntu-18.04", "--", "bash", "-lc", `gzip -t '${filePath.replaceAll("\\", "/").replace(/^([A-Za-z]):/u, (_m, drive) => `/mnt/${drive.toLowerCase()}`)}' && tar -tzf '${filePath.replaceAll("\\", "/").replace(/^([A-Za-z]):/u, (_m, drive) => `/mnt/${drive.toLowerCase()}`)}' >/dev/null`]
    : ["-tzf", filePath];
  const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error("Runtime archive failed gzip/tar integrity verification");
}
