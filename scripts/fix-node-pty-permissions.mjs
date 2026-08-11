import { chmod, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// node-pty ships a `spawn-helper` executable next to its POSIX prebuilds, and
// installs land it without the executable bit. node-pty then fails every pty
// launch with a bare "posix_spawnp failed", which surfaces as a broken terminal
// panel in `npm run dev` and as terminal E2E failures. Packaged builds get the
// same treatment from scripts/after-pack.mjs; this covers the working tree.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prebuildsDir = path.join(rootDir, "node_modules", "node-pty", "prebuilds");

if (process.platform === "win32") process.exit(0);

const helpers = (await listFiles(prebuildsDir))
  .filter((filePath) => path.basename(filePath) === "spawn-helper");

let fixed = 0;
for (const filePath of helpers) {
  const mode = (await stat(filePath)).mode;
  if (mode & 0o111) continue;
  await chmod(filePath, 0o755);
  fixed += 1;
}

if (fixed > 0) console.log(`Marked ${fixed} node-pty spawn-helper file(s) executable.`);

async function listFiles(directory) {
  // A missing directory just means node-pty is not installed yet; never fail
  // the install over it.
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat();
}
