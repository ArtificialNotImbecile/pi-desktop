import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const rootDir = process.cwd();
const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const version = manifest.version;
const ciWorkflow = await readFile(path.join(rootDir, ".github", "workflows", "ci.yml"), "utf8");
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
  assert.match(ciWorkflow, /group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/,
    "CI concurrency must group successive runs by pull request or branch");
  assert.match(ciWorkflow, /cancel-in-progress: true/,
    "CI must cancel superseded pull request and main runs");
  assert.match(releaseWorkflow, /group: release-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}/,
    "manual prebuilds and formal tag builds must use separate concurrency groups");
  assert.match(releaseWorkflow, /cancel-in-progress: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/,
    "only superseded manual release prebuilds may be cancelled");
  assert.match(releaseWorkflow, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/'\)/,
    "manual tag prebuilds must never race a tag push to publish the same release");
  assert.equal((ciWorkflow.match(/uses: actions\/cache@v6/g) || []).length, 3,
    "every CI dependency-install job must restore the Electron cache");
  assert.equal((releaseWorkflow.match(/uses: actions\/cache@v6/g) || []).length, 1,
    "release dependency-install jobs must restore the Electron cache");
  for (const [name, workflow, expectedInstalls] of [
    ["CI", ciWorkflow, 3],
    ["Release", releaseWorkflow, 1]
  ]) {
    assert.equal((workflow.match(/id: npm_ci/g) || []).length, expectedInstalls,
      `${name} must mark each first dependency-install attempt`);
    assert.equal((workflow.match(/if: steps\.npm_ci\.outcome == 'failure'/g) || []).length, expectedInstalls,
      `${name} must retry each failed dependency install exactly once`);
    assert.equal((workflow.match(/electron_config_cache: \$\{\{ runner\.temp \}\}\/electron-cache/g) || []).length, expectedInstalls * 2,
      `${name} must use the cached Electron download on both bounded install attempts`);
  }
  assert.match(ciWorkflow, /name: Run renderer tests\s+if: matrix\.id == 'linux-x64'/,
    "renderer tests must run once rather than once per platform");
  assert.equal((ciWorkflow.match(/label: (?:Linux x64|Windows x64)/g) || []).length, 2,
    "the verify matrix should contain only Linux and Windows");
  assert.ok(!ciWorkflow.includes("label: macOS Apple Silicon"),
    "macOS must not repeat an install and build outside its full E2E jobs");
  assert.ok(ciWorkflow.includes("name: Run macOS unit tests"),
    "the serial macOS E2E job must retain native unit coverage");
  assert.ok(ciWorkflow.indexOf("name: Run macOS unit tests") > ciWorkflow.indexOf("name: Run focus-sensitive and startup-timing projects"),
    "macOS unit smoke must run after cold-start timing so it cannot warm Electron first");
  assert.match(ciWorkflow, /name: Run macOS unit tests\s+if: \$\{\{ !cancelled\(\) && steps\.build\.outcome == 'success' \}\}/,
    "macOS native unit coverage must still run after an E2E failure when the build is usable");
  assert.ok(ciWorkflow.includes("shard: [1, 2]"),
    "the reduced main E2E suite should use two shards, not repeat a third install and build");
  assert.ok(ciWorkflow.includes("--shard=${{ matrix.shard }}/2"),
    "the E2E command must use the same two-way split as the matrix");

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
