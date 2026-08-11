import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat();
}

const sourceDirectory = path.resolve(readArgument("--source") || "release-assets");
const outputDirectory = path.resolve(readArgument("--output") || "release-ready");
const version = (readArgument("--version") || "").replace(/^v/, "");

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`A semantic version is required via --version; received ${JSON.stringify(version)}.`);
}

// The `latest*.yml` manifests are the in-app updater's feed: Windows reads
// latest.yml, macOS latest-mac.yml (which requires the zip, not the dmg), and
// Linux latest-linux.yml. Dropping one silently disables updates for that
// platform, so they are verified alongside the installers.
const expectedNames = [
  `Jasmine-Setup-${version}-x64.exe`,
  `Jasmine-Setup-${version}-x64.exe.blockmap`,
  "latest.yml",
  `Jasmine-${version}-linux-x86_64.AppImage`,
  `Jasmine-${version}-linux-amd64.deb`,
  "latest-linux.yml",
  `Jasmine-${version}-mac-arm64.dmg`,
  `Jasmine-${version}-mac-arm64.zip`,
  "latest-mac.yml"
];

const sourceFiles = await listFiles(sourceDirectory);
const filesByName = new Map();
for (const filePath of sourceFiles) {
  const name = path.basename(filePath);
  const matches = filesByName.get(name) || [];
  matches.push(filePath);
  filesByName.set(name, matches);
}

const missing = expectedNames.filter((name) => !filesByName.has(name));
const duplicates = expectedNames.filter((name) => (filesByName.get(name) || []).length > 1);
if (missing.length > 0 || duplicates.length > 0) {
  throw new Error([
    missing.length > 0 ? `Missing release assets: ${missing.join(", ")}` : "",
    duplicates.length > 0 ? `Duplicate release assets: ${duplicates.join(", ")}` : ""
  ].filter(Boolean).join("\n"));
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const checksumLines = [];
for (const name of expectedNames) {
  const sourcePath = filesByName.get(name)[0];
  const destinationPath = path.join(outputDirectory, name);
  await copyFile(sourcePath, destinationPath);
  const digest = createHash("sha256").update(await readFile(destinationPath)).digest("hex");
  checksumLines.push(`${digest}  ${name}`);
}
await writeFile(path.join(outputDirectory, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`, "utf8");

console.log(`Prepared ${expectedNames.length} verified release assets for Jasmine ${version}.`);
