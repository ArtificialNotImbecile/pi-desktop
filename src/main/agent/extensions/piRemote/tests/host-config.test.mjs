import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const profileId = "11111111-1111-4111-8111-111111111111";
const artifactSha = "a".repeat(64);
const hostPath = fileURLToPath(new URL("../dist/host.js", import.meta.url));

test("host config sync clears omitted portable defaults and accepts a full-size models envelope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-host-config-"));
  const remoteRoot = path.join(root, "remote");
  const runtimeRoot = path.join(root, "runtime");
  const agentDir = path.join(remoteRoot, "profiles", profileId, "agent");
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "old-provider",
      defaultModel: "old-model",
      defaultThinkingLevel: "high",
      theme: "remote-only"
    }));

    const modelBudget = 2 * 1024 * 1024;
    const emptyModels = { providers: { fixture: { payload: "" } } };
    const models = { providers: { fixture: { payload: "x".repeat(modelBudget - Buffer.byteLength(JSON.stringify(emptyModels))) } } };
    const modelsJson = JSON.stringify(models);
    const payload = JSON.stringify({ models, settings: {} });
    assert.ok(Buffer.byteLength(modelsJson) <= modelBudget, "models.json must stay within the documented local limit");
    assert.ok(Buffer.byteLength(payload) > modelBudget, "the host payload must exercise JSON envelope overhead beyond 2 MiB");

    const result = await runHostConfig(root, remoteRoot, runtimeRoot, payload);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /PI_REMOTE_CONFIG\/1/u);
    const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settings, { theme: "remote-only" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runHostConfig(root, remoteRoot, runtimeRoot, input) {
  const child = spawn(process.execPath, [
    hostPath,
    "config", "sync",
    "--profile", profileId,
    "--remote-root", remoteRoot,
    "--runtime-root", runtimeRoot,
    "--artifact-sha", artifactSha
  ], {
    env: { ...process.env, XDG_RUNTIME_DIR: path.join(root, "run") },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}
