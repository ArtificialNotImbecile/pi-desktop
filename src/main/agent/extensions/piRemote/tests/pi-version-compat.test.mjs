import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("thin extension loads under Jasmine's Pi 0.84.1 and package baseline 0.84.2", async () => {
  const packageRoot = process.cwd();
  const extension = path.join(packageRoot, "dist", "extension.js");
  const root0841 = path.resolve(packageRoot, "../../../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const package0842 = path.join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  for (const [version, cli] of [["0.84.1", root0841], ["0.84.2", package0842]]) {
    const result = await run(process.execPath, [cli, "--extension", extension, "--help"]);
    assert.equal(result.code, 0, `${version}: ${result.stderr}`);
    assert.match(result.stdout, /pi - AI coding assistant/u);
  }
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
