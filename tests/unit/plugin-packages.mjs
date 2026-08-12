import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { listPluginPackages, syncBundledPluginPackages } = await import("../../dist/main/main/services/plugins.js");
const tempRoot = await mkdtemp(path.join(tmpdir(), "jasmine-packages-"));

try {
  const retiredUserData = path.join(tempRoot, "retired");
  const retiredDir = path.join(retiredUserData, "plugins", "chrome");
  const customDir = path.join(retiredUserData, "plugins", "custom-package");
  await writePackage(retiredDir, {
    name: "chrome",
    version: "0.1.0",
    type: "module",
    pi: { extensions: ["./index.js"], skills: ["./skills"] }
  });
  await writeFile(path.join(retiredDir, "index.js"), "export default function chrome() {}\n", "utf8");
  await mkdir(path.join(retiredDir, "skills"), { recursive: true });
  await writePackage(customDir, { name: "custom-package", version: "1.0.0", pi: {} });

  const installed = await syncBundledPluginPackages(retiredUserData);
  await assert.rejects(access(retiredDir));
  assert.deepEqual(installed, []);
  await access(path.join(customDir, "package.json"));

  const userOwnedData = path.join(tempRoot, "user-owned");
  const userOwnedChrome = path.join(userOwnedData, "plugins", "chrome");
  await writePackage(userOwnedChrome, { name: "chrome", version: "9.9.9", pi: { extensions: ["./custom.js"] } });
  await writeFile(path.join(userOwnedChrome, "custom.js"), "export default function customChrome() {}\n", "utf8");

  assert.deepEqual(await syncBundledPluginPackages(userOwnedData), []);
  await access(path.join(userOwnedChrome, "custom.js"));
  const userOwnedAgentDir = path.join(userOwnedData, "pi-agent");
  await mkdir(userOwnedAgentDir, { recursive: true });
  await writeFile(path.join(userOwnedAgentDir, "settings.json"), JSON.stringify({ packages: [userOwnedChrome] }, null, 2), "utf8");
  const userOwnedRecords = await listPluginPackages({ userDataDir: userOwnedData });
  const userOwnedRecord = userOwnedRecords.find((record) => record.source === userOwnedChrome);
  assert.equal(userOwnedRecord?.builtin, false);
  assert.equal(userOwnedRecord?.removable, true);
  const userOwnedSettings = JSON.parse(await readFile(path.join(userOwnedAgentDir, "settings.json"), "utf8"));
  assert.equal(userOwnedSettings.packages.some((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    return typeof source === "string" && path.resolve(source) === path.resolve(userOwnedChrome);
  }), true);

  console.log("plugin-packages unit test passed");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function writePackage(directory, packageJson) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");
}
