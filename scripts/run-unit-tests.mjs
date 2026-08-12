// Runs all unit test files in parallel with per-file pass/fail reporting.
// Serial `a && b && c` chaining hid which file failed and made the suite
// ~2x slower than its slowest file.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

if (!existsSync(path.join(rootDir, "dist", "main", "main"))) {
  console.error("Unit tests import compiled output from dist/. Run `npm run build` first.");
  process.exit(1);
}

const tasks = [
  { name: "database-smoke", steps: [["node", "--no-warnings", "tests/unit/database-smoke.mjs"]] },
  { name: "working-registry", steps: [["node", "--no-warnings", "tests/unit/working-registry.mjs"]] },
  { name: "app-updater", steps: [["node", "--no-warnings", "tests/unit/app-updater.mjs"]] },
  { name: "stream-delta", steps: [["node", "--no-warnings", "tests/unit/stream-delta.mjs"]] },
  { name: "pi-runtime-equivalence", steps: [["node", "--no-warnings", "tests/unit/pi-runtime-equivalence.mjs"]] },
  { name: "pi-context-usage", steps: [["node", "--no-warnings", "tests/unit/pi-context-usage.mjs"]] },
  { name: "pi-session-import", steps: [["node", "--no-warnings", "tests/unit/pi-session-import.mjs"]] },
  { name: "plugin-packages", steps: [["node", "--no-warnings", "tests/unit/plugin-packages.mjs"]] },
  { name: "icon-assets", steps: [["node", "--no-warnings", "tests/unit/icon-assets-smoke.mjs"]] },
  { name: "startup-bootstrap", steps: [["node", "--no-warnings", "tests/unit/startup-bootstrap-smoke.mjs"]] },
  { name: "release-workflow", steps: [["node", "--no-warnings", "tests/unit/release-workflow.mjs"]] },
  { name: "preload-bridge-parity", steps: [["node", "--no-warnings", "tests/unit/preload-bridge-parity.mjs"]] },
  {
    name: "context-capture",
    steps: [
      [npmCommand, "--prefix", "src/main/agent/extensions/contextCapture", "run", "build"],
      ["node", "--no-warnings", "scripts/smoke-context-capture-package.mjs"]
    ]
  },
  {
    name: "permission-gate",
    steps: [
      [npmCommand, "--prefix", "src/main/agent/extensions/permissionGate", "test"]
    ]
  },
  {
    name: "file-changes",
    steps: [
      [npmCommand, "--prefix", "src/main/agent/extensions/fileChanges", "test"]
    ]
  }
];

function runStep([command, ...args]) {
  return new Promise((resolve) => {
    // Node on Windows refuses to spawn .cmd shims without a shell (CVE-2024-27980).
    const child = command.endsWith(".cmd")
      ? spawn([command, ...args].join(" "), { cwd: rootDir, shell: true, windowsHide: true })
      : spawn(command, args, { cwd: rootDir, windowsHide: true });
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
