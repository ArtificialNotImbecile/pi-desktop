import { chmod, readdir } from "node:fs/promises";
import path from "node:path";

export async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const helpers = (await listFiles(context.appOutDir))
    .filter((filePath) => path.basename(filePath) === "spawn-helper")
    .filter((filePath) => filePath.includes(`${path.sep}node-pty${path.sep}prebuilds${path.sep}`));

  if (helpers.length === 0) {
    throw new Error(`node-pty spawn-helper was not unpacked into the macOS application: ${context.appOutDir}`);
  }

  await Promise.all(helpers.map((filePath) => chmod(filePath, 0o755)));
  console.log(`Marked ${helpers.length} packaged node-pty spawn-helper file(s) executable.`);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat();
}
