import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const rootDir = process.cwd();
const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const version = manifest.version;
const releaseWorkflow = await readFile(path.join(rootDir, ".github", "workflows", "release.yml"), "utf8");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "jasmine-release-workflow-"));
const sourceDirectory = path.join(temporaryRoot, "source");
const outputDirectory = path.join(temporaryRoot, "output");
const mockMacApp = path.join(temporaryRoot, "Jasmine.app");
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

try {
  assert.equal(manifest.desktopName, manifest.build.appId, "Linux desktopName must match the Electron app id");
  assert.ok(manifest.build.linux.maintainer, "Linux deb packaging requires a maintainer");
  assert.equal(manifest.build.linux.executableName, "jasmine");
  assert.equal(manifest.build.linux.syncDesktopName, true);
  assert.ok(manifest.build.asarUnpack.includes("node_modules/node-pty/prebuilds/**"));
  assert.equal(manifest.build.afterPack, "./scripts/after-pack.mjs");
  assert.equal((releaseWorkflow.match(/--publish never/g) || []).length, 3,
    "all platform build jobs must disable electron-builder's implicit CI publishing");
  assert.ok(releaseWorkflow.includes("Jasmine-*-linux-x86_64.AppImage"));
  assert.ok(releaseWorkflow.includes("Jasmine-*-linux-amd64.deb"));
  // The in-app updater reads a per-platform manifest; macOS additionally needs
  // the zip, because Squirrel.Mac cannot install from a dmg.
  assert.ok(releaseWorkflow.includes("--mac dmg zip --arm64"), "macOS packaging must emit the updater's zip artifact");
  assert.ok(manifest.build.mac.target.some((target) => target.target === "zip"));
  for (const manifestName of ["latest.yml", "latest-mac.yml", "latest-linux.yml"]) {
    assert.ok(releaseWorkflow.includes(`release/v*/${manifestName}`), `${manifestName} must be uploaded`);
  }
  assert.ok(releaseWorkflow.includes("actions/upload-artifact@v7"));
  assert.ok(releaseWorkflow.includes("actions/download-artifact@v8"));

  const mockSpawnHelper = path.join(mockMacApp, "Contents", "Resources", "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
  await mkdir(path.dirname(mockSpawnHelper), { recursive: true });
  await writeFile(mockSpawnHelper, "mock helper\n", "utf8");
  await chmod(mockSpawnHelper, 0o644);
  const { afterPack } = await import("../../scripts/after-pack.mjs");
  await afterPack({ electronPlatformName: "darwin", appOutDir: mockMacApp });
  if (process.platform !== "win32") {
    assert.equal((await stat(mockSpawnHelper)).mode & 0o777, 0o755);
  }

  const validTag = spawnSync(process.execPath, ["scripts/validate-release-version.mjs"], {
    cwd: rootDir,
    env: { ...process.env, RELEASE_TAG: `v${version}` },
    encoding: "utf8"
  });
  assert.equal(validTag.status, 0, validTag.stderr);

  const invalidTag = spawnSync(process.execPath, ["scripts/validate-release-version.mjs"], {
    cwd: rootDir,
    env: { ...process.env, RELEASE_TAG: "v999.0.0" },
    encoding: "utf8"
  });
  assert.notEqual(invalidTag.status, 0, "a mismatched tag must fail validation");

  await Promise.all(expectedNames.map(async (name, index) => {
    const nestedDirectory = path.join(sourceDirectory, `platform-${index % 4}`);
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(path.join(nestedDirectory, name), `asset:${name}\n`, "utf8");
  }));

  const prepared = spawnSync(process.execPath, [
    "scripts/prepare-release-assets.mjs",
    "--source", sourceDirectory,
    "--output", outputDirectory,
    "--version", `v${version}`
  ], { cwd: rootDir, encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);

  const outputNames = (await readdirNames(outputDirectory)).sort();
  assert.deepEqual(outputNames, [...expectedNames, "SHA256SUMS.txt"].sort());
  const checksums = await readFile(path.join(outputDirectory, "SHA256SUMS.txt"), "utf8");
  for (const name of expectedNames) assert.match(checksums, new RegExp(`  ${escapeRegExp(name)}(?:\\r?\\n|$)`));

  await rm(path.join(sourceDirectory, "platform-0", expectedNames[0]));
  const missingAsset = spawnSync(process.execPath, [
    "scripts/prepare-release-assets.mjs",
    "--source", sourceDirectory,
    "--output", outputDirectory,
    "--version", version
  ], { cwd: rootDir, encoding: "utf8" });
  assert.notEqual(missingAsset.status, 0, "a missing platform asset must fail release preparation");
  assert.match(missingAsset.stderr, /Missing release assets/);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function readdirNames(directory) {
  const { readdir } = await import("node:fs/promises");
  return readdir(directory);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

console.log(`Release workflow validation passed for Jasmine ${version}.`);
