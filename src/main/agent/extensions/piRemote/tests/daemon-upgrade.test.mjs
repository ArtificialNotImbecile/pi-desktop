import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquireSessionMode,
  daemonStatus,
  ensureHostPaths,
  releaseSessionMode
} from "../dist/daemon.js";

const profileId = "22222222-2222-4222-8222-222222222222";
const hostPath = fileURLToPath(new URL("../dist/host.js", import.meta.url));

test("daemon ensure replaces an idle stale runtime but preserves active work", {
  // The managed host is Linux-only, and daemonStatus intentionally validates
  // other PIDs through /proc process identity rather than a portable fallback.
  skip: process.platform !== "linux"
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-daemon-upgrade-"));
  const remoteRoot = path.join(root, "remote");
  const runtimeRoot = path.join(remoteRoot, "runtimes", "current");
  const runtimeDir = path.join(root, "run");
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  const artifactA = "a".repeat(64);
  const artifactB = "b".repeat(64);
  const artifactC = "c".repeat(64);
  const paths = await ensureHostPaths(remoteRoot, runtimeRoot, profileId);
  let modeLease = false;
  try {
    const first = await runHost(root, runtimeDir, "daemon", "ensure", artifactA);
    assert.equal(first.code, 0, first.stderr);
    const firstStatus = await daemonStatus(paths);
    assert.equal(firstStatus.running, true);
    assert.equal(firstStatus.artifactSha256, artifactA);

    const upgraded = await runHost(root, runtimeDir, "daemon", "ensure", artifactB);
    assert.equal(upgraded.code, 0, upgraded.stderr);
    const upgradedStatus = await daemonStatus(paths);
    assert.equal(upgradedStatus.running, true);
    assert.equal(upgradedStatus.artifactSha256, artifactB);
    assert.notEqual(upgradedStatus.pid, firstStatus.pid, "idle stale daemon must be replaced");

    await acquireSessionMode(paths, "rpc", "active-upgrade-test");
    modeLease = true;
    const blocked = await runHost(root, runtimeDir, "daemon", "ensure", artifactC);
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /daemon-runtime-stale/u);
    const preserved = await daemonStatus(paths);
    assert.equal(preserved.pid, upgradedStatus.pid);
    assert.equal(preserved.artifactSha256, artifactB);
  } finally {
    if (modeLease) await releaseSessionMode(paths, "active-upgrade-test").catch(() => {});
    await runHost(root, runtimeDir, "daemon", "stop", artifactB).catch(() => {});
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    await rm(root, { recursive: true, force: true });
  }
});

async function runHost(root, runtimeDir, group, command, artifactSha256) {
  const child = spawn(process.execPath, [
    hostPath,
    group,
    command,
    "--profile", profileId,
    "--remote-root", path.join(root, "remote"),
    "--runtime-root", path.join(root, "remote", "runtimes", "current"),
    "--artifact-sha", artifactSha256
  ], {
    env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  });
  return { code, stdout, stderr };
}
