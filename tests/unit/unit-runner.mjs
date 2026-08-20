import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const readJson = async (relativePath) => JSON.parse(await readFile(path.join(rootDir, relativePath), "utf8"));
const rootManifest = await readJson("package.json");
const permissionManifest = await readJson("src/main/agent/extensions/permissionGate/package.json");
const fileChangesManifest = await readJson("src/main/agent/extensions/fileChanges/package.json");
const piRemoteManifest = await readJson("src/main/agent/extensions/piRemote/package.json");
const runner = await readFile(path.join(rootDir, "scripts", "run-unit-tests.mjs"), "utf8");

assert.match(
  rootManifest.scripts.build,
  /build:context-capture.*build:file-changes.*build:permission-gate.*build:pi-remote/,
  "the root build must compile every extension whose built output the unit runner consumes"
);
assert.equal(
  permissionManifest.scripts.test,
  "npm run build && node --test tests/permission-gate.test.mjs",
  "the permission-gate standalone test must remain self-building"
);
assert.equal(
  fileChangesManifest.scripts.test,
  "npm run build && node --test tests/*.test.mjs",
  "the file-changes standalone test must remain self-building"
);
assert.equal(
  piRemoteManifest.scripts.test,
  "npm run build && node --test tests/*.test.mjs",
  "the pi-remote standalone test must remain self-building"
);

assert.match(runner, /scripts\/smoke-context-capture-package\.mjs/);
assert.match(runner, /packageTestStep\(path\.join\("src", "main", "agent", "extensions", "permissionGate"\), \["tests\/permission-gate\.test\.mjs"\]\)/);
assert.match(runner, /packageTestFiles\(path\.join\("src", "main", "agent", "extensions", "fileChanges"\)\)/);
assert.match(runner, /packageTestFiles\(path\.join\("src", "main", "agent", "extensions", "piRemote"\)\)/);
assert.match(runner, /cwd: path\.join\(rootDir, packagePath\)/,
  "direct package tests must keep the same working directory as standalone npm test");
assert.doesNotMatch(runner, /npm --prefix|npmCommand/,
  "the root unit runner must not rebuild extension packages after the root build");

console.log("Root unit runner reuses the complete prebuilt extension test surface.");
