// Runs all unit test files in parallel with per-file pass/fail reporting.
// Serial `a && b && c` chaining hid which file failed and made the suite
// ~2x slower than its slowest file. The root build compiles all extension
// packages first, so this runner executes their post-build checks directly.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredBuildArtifacts = [
  path.join("dist", "main", "main"),
  path.join("src", "main", "agent", "extensions", "contextCapture", "dist", "index.js"),
  path.join("src", "main", "agent", "extensions", "permissionGate", "dist", "index.js"),
  path.join("src", "main", "agent", "extensions", "fileChanges", "dist", "index.js"),
  path.join("src", "main", "agent", "extensions", "piRemote", "dist", "index.js")
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

function packageTestFiles(packagePath) {
  const testDir = path.join(rootDir, packagePath, "tests");
  return readdirSync(testDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join(packagePath, "tests", name));
}

function packageTestStep(packagePath, testFiles) {
  return {
    command: "node",
    args: ["--test", ...testFiles],
    cwd: path.join(rootDir, packagePath)
  };
}

const tasks = [
  { name: "database-smoke", steps: [["node", "--no-warnings", "tests/unit/database-smoke.mjs"]] },
  { name: "working-registry", steps: [["node", "--no-warnings", "tests/unit/working-registry.mjs"]] },
  { name: "i18n-parity", steps: [["node", "--no-warnings", "tests/unit/i18n-parity.mjs"]] },
  { name: "app-updater", steps: [["node", "--no-warnings", "tests/unit/app-updater.mjs"]] },
  { name: "stream-delta", steps: [["node", "--no-warnings", "tests/unit/stream-delta.mjs"]] },
  { name: "pi-runtime-equivalence", steps: [["node", "--no-warnings", "tests/unit/pi-runtime-equivalence.mjs"]] },
  { name: "pi-context-usage", steps: [["node", "--no-warnings", "tests/unit/pi-context-usage.mjs"]] },
  { name: "pi-session-import", steps: [["node", "--no-warnings", "tests/unit/pi-session-import.mjs"]] },
  { name: "plugin-packages", steps: [["node", "--no-warnings", "tests/unit/plugin-packages.mjs"]] },
  { name: "icon-assets", steps: [["node", "--no-warnings", "tests/unit/icon-assets-smoke.mjs"]] },
  { name: "spotlight-shortcut", steps: [["node", "--no-warnings", "tests/unit/spotlight-shortcut.mjs"]] },
  { name: "startup-bootstrap", steps: [["node", "--no-warnings", "tests/unit/startup-bootstrap-smoke.mjs"]] },
  { name: "release-workflow", steps: [["node", "--no-warnings", "tests/unit/release-workflow.mjs"]] },
  { name: "unit-runner", steps: [["node", "--no-warnings", "tests/unit/unit-runner.mjs"]] },
  { name: "test-infrastructure", steps: [["node", "--no-warnings", "tests/unit/test-infrastructure.mjs"]] },
  { name: "renderer-font-assets", steps: [["node", "--no-warnings", "tests/unit/renderer-font-assets.mjs"]] },
  { name: "preload-bridge-parity", steps: [["node", "--no-warnings", "tests/unit/preload-bridge-parity.mjs"]] },
  { name: "local-files", steps: [["node", "--no-warnings", "tests/unit/local-files.mjs"]] },
  {
    name: "context-capture",
    steps: [
      ["node", "--no-warnings", "scripts/smoke-context-capture-package.mjs"]
    ]
  },
  {
    name: "permission-gate",
    steps: [
      packageTestStep(path.join("src", "main", "agent", "extensions", "permissionGate"), ["tests/permission-gate.test.mjs"])
    ]
  },
  {
    name: "file-changes",
    steps: [
      packageTestStep(
        path.join("src", "main", "agent", "extensions", "fileChanges"),
        packageTestFiles(path.join("src", "main", "agent", "extensions", "fileChanges"))
          .map((testFile) => path.relative(path.join("src", "main", "agent", "extensions", "fileChanges"), testFile))
      )
    ]
  },
  {
    name: "pi-remote",
    steps: [
      packageTestStep(
        path.join("src", "main", "agent", "extensions", "piRemote"),
        packageTestFiles(path.join("src", "main", "agent", "extensions", "piRemote"))
          .map((testFile) => path.relative(path.join("src", "main", "agent", "extensions", "piRemote"), testFile))
      )
    ]
  }
];

function runStep(step) {
  return new Promise((resolve) => {
    const { command, args, cwd } = Array.isArray(step)
      ? { command: step[0], args: step.slice(1), cwd: rootDir }
      : step;
    // Node on Windows refuses to spawn .cmd shims without a shell (CVE-2024-27980).
    const child = command.endsWith(".cmd")
      ? spawn([command, ...args].join(" "), { cwd, shell: true, windowsHide: true })
      : spawn(command, args, { cwd, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => resolve({ code: 1, output: `${output}\n${error.message}` }));
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function runTask(task) {
  const startedAt = Date.now();
  let output = "";
  for (const step of task.steps) {
    const result = await runStep(step);
    output += result.output;
    if (result.code !== 0) {
      return { ...task, ok: false, seconds: (Date.now() - startedAt) / 1000, output };
    }
  }
  return { ...task, ok: true, seconds: (Date.now() - startedAt) / 1000, output };
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
