import assert from "node:assert/strict";
import test from "node:test";
import { daemonMatchesRuntime, tuiRequestMatches } from "../dist/host.js";

test("TUI reattach accepts an implicit reconnect but rejects changed cwd, session, or proxy", () => {
  const active = {
    cwd: "/workspace",
    piArgs: ["--session", "session-a"],
    proxy: { url: "http://pi:token@127.0.0.1:50000", noProxy: ["localhost"] }
  };
  assert.equal(tuiRequestMatches(active, { cwd: "/workspace", piArgs: [], proxy: active.proxy }), true);
  assert.equal(tuiRequestMatches(active, { cwd: "/other", piArgs: [], proxy: active.proxy }), false);
  assert.equal(tuiRequestMatches(active, { cwd: "/workspace", piArgs: ["--session", "session-b"], proxy: active.proxy }), false);
  assert.equal(tuiRequestMatches(active, { cwd: "/workspace", piArgs: [], proxy: null }), false);
});

test("daemon reuse requires both the current runtime version and exact artifact", () => {
  const artifactSha256 = "a".repeat(64);
  assert.equal(daemonMatchesRuntime({ runtimeVersion: "0.1.0", artifactSha256 }, { artifactSha256 }), true);
  assert.equal(daemonMatchesRuntime({ runtimeVersion: "0.0.9", artifactSha256 }, { artifactSha256 }), false);
  assert.equal(daemonMatchesRuntime({ runtimeVersion: "0.1.0", artifactSha256: "b".repeat(64) }, { artifactSha256 }), false);
  assert.equal(daemonMatchesRuntime({ runtimeVersion: "0.1.0" }, { artifactSha256 }), false);
});
