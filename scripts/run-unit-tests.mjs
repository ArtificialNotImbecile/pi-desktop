// Runs all unit test files in parallel with per-file pass/fail reporting.
// Serial `a && b && c` chaining hid which file failed and made the suite
// ~2x slower than its slowest file. The root build compiles all extension
// packages first, so this runner executes their post-build checks directly.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDir = path.join("src", "main", "agent", "extensions");
const requiredBuildArtifacts = [
  path.join("dist", "main", "main"),
  ...["contextCapture", "permissionGate", "fileChanges", "piRemote"].map((name) => path.join(extensionsDir, name, "dist", "index.js"))
];
const missingBuildArtifacts = requiredBuildArtifacts.filter((artifact) => !existsSync(path.join(rootDir, artifact)));

if (missingBuildArtifacts.length > 0) {
  console.error([
    "Unit tests import compiled output from the root application and extension packages.",
    "Run `npm run build` first. Missing:",
    ...missingBuildArtifacts.map((artifact) => `- ${artifact}`)
  ].join("\n"));
  process.exit(1);
}

function unitTest(name, file = `tests/unit/${name}.mjs`) {
  return { name, args: ["--no-warnings", file], cwd: rootDir };
}

// Runs the package's node:test files from the package directory, the same
// working directory its standalone `npm test` uses.
function packageTests(name, directory) {
  const packageDir = path.join(rootDir, extensionsDir, directory);
  const testFiles = readdirSync(path.join(packageDir, "tests"))
    .filter((entry) => entry.endsWith(".test.mjs"))
    .sort()
    .map((entry) => path.join("tests", entry));
  return { name, args: ["--test", ...testFiles], cwd: packageDir };
}

const tasks = [
  unitTest("database-smoke"),
  unitTest("working-registry"),
  unitTest("i18n-parity"),
  unitTest("app-updater"),
  unitTest("stream-delta"),
  unitTest("pi-runtime-equivalence"),
  unitTest("pi-context-usage"),
  unitTest("pi-session-import"),
  unitTest("plugin-packages"),
  unitTest("icon-assets", "tests/unit/icon-assets-smoke.mjs"),
  unitTest("spotlight-shortcut"),
  unitTest("startup-bootstrap", "tests/unit/startup-bootstrap-smoke.mjs"),
  unitTest("release-workflow"),
  unitTest("test-infrastructure"),
  unitTest("renderer-font-assets"),
  unitTest("local-files"),
  unitTest("remote-sessions"),
  unitTest("context-capture", "scripts/smoke-context-capture-package.mjs"),
  packageTests("permission-gate", "permissionGate"),
  packageTests("file-changes", "fileChanges"),
  packageTests("pi-remote", "piRemote")
];

function runTask(task) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn("node", task.args, { cwd: task.cwd, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const finish = (ok) => resolve({ ...task, ok, seconds: (Date.now() - startedAt) / 1000, output });
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(false);
    });
    child.on("exit", (code) => finish(code === 0));
  });
}

const startedAt = Date.now();
const results = await Promise.all(tasks.map(runTask));
const failed = results.filter((result) => !result.ok);

for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name} (${result.seconds.toFixed(1)}s)`);
}
for (const result of failed) {
  console.error(`\n===== ${result.name} output =====\n${result.output.trim()}\n`);
}
console.log(`\n${results.length - failed.length}/${results.length} unit suites passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
if (failed.length > 0) process.exit(1);
