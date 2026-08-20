import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManagedRemoteRuntime, ProfileStore } from "../dist/index.js";

const host = process.env.PI_REMOTE_E2E_HOST;
const port = Number(process.env.PI_REMOTE_E2E_PORT || 22);
const ticket = randomBytes(8).toString("hex");
const localRoot = await mkdtemp(path.join(os.tmpdir(), "pi-remote-upgrade-"));
const configPath = path.join(localRoot, "profiles.json");
process.env.PI_REMOTE_CONFIG_PATH = configPath;
const remoteRoot = `/tmp/pi-remote-upgrade-${ticket}`;
const remoteCwd = `/tmp/pi-remote-upgrade-cwd-${ticket}`;
const prevArtifactDir = requiredEnv("PI_REMOTE_E2E_PREVIOUS_ARTIFACT_DIR");

const store = new ProfileStore(configPath);
const manager = new ManagedRemoteRuntime();
const previousManager = new ManagedRemoteRuntime({ artifactDirectory: prevArtifactDir });
let profile;
let completed = false;

try {
  profile = await store.add({ name: `upgrade-${ticket}`, sshHost: host, sshPort: port, defaultCwd: remoteCwd, remoteRoot });
  assert((await manager.doctor(profile)).ok, "doctor");

  // Step 1: current package runtime installed on first connect.
  const info = await manager.ensureRuntime(profile);
  const currentAfterFirst = await readCurrent();
  assert(currentAfterFirst.endsWith(info.artifactSha256), "first connect installs package runtime");
  const cwdSetup = await manager.ssh.run(profile, `mkdir -p -- ${remoteCwd}`);
  assert(cwdSetup.code === 0, "upgrade fixture cwd exists before opening the old runtime session");

  // Sync a local model config so we can prove updates preserve it.
  const syncAgentDir = path.join(localRoot, "agent");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(syncAgentDir, { recursive: true });
  const models = JSON.parse(await readFile(new URL("../tests/fixtures/models.json", import.meta.url), "utf8"));
  const settings = JSON.parse(await readFile(new URL("../tests/fixtures/settings.json", import.meta.url), "utf8"));
  await writeFile(path.join(syncAgentDir, "models.json"), JSON.stringify(models));
  await writeFile(path.join(syncAgentDir, "settings.json"), JSON.stringify(settings));
  const { loadLocalPiModelConfig } = await import("../dist/index.js");
  await manager.syncModelConfig(profile, await loadLocalPiModelConfig(syncAgentDir));
  const configHashBefore = await manager.ssh.run(profile, `sha256sum ${profile.remoteRoot ?? remoteRoot}/profiles/${profile.id}/agent/models.json`);

  // Step 2: an older shipped runtime (distinct sha, same content) is installed by the previous package.
  const previousInfo = await previousManager.ensureRuntime(profile);
  assert(previousInfo.artifactSha256 !== info.artifactSha256, "upgrade fixture uses a distinct content-addressed runtime");
  const currentAfterOld = await readCurrent();
  assert(currentAfterOld.endsWith(previousInfo.artifactSha256), "older package runtime selected while it is the shipped artifact");
  const previousPort = await previousManager.openSession(profile, { cwd: remoteCwd });
  await previousPort.close({ abort: false });

  // Step 3: the very next connection with the current package must auto-upgrade back.
  const sessionsAfterUpgrade = await manager.listSessions(profile);
  assert(Array.isArray(sessionsAfterUpgrade), "first current-runtime connection replaces the idle stale daemon");
  const upgraded = await manager.ensureRuntime(profile);
  assert(upgraded.artifactSha256 === info.artifactSha256, "next connection auto-upgrades to current package artifact");
  const currentAfterUpgrade = await readCurrent();
  assert(currentAfterUpgrade.endsWith(info.artifactSha256), "current runtime symlink switched after upgrade");

  // Step 4: upgrade preserves the profile model configuration.
  const configHashAfter = await manager.ssh.run(profile, `sha256sum ${remoteRoot}/profiles/${profile.id}/agent/models.json`);
  assert(configHashBefore.stdout.trim() === configHashAfter.stdout.trim(), "runtime update preserves profile model configuration");

  // Step 5: both runtime generations coexist content-addressed; the old one can be removed later.
  await manager.ssh.run(profile, `rm -rf -- ${remoteRoot}/runtimes/${previousInfo.artifactSha256}`);
  const stillWorks = await manager.ensureRuntime(profile);
  assert(stillWorks.artifactSha256 === info.artifactSha256, "runtime still healthy after old generation cleanup");

  completed = true;
  process.stdout.write(`${JSON.stringify({ ok: true, results: ["runtime-auto-upgrade", "idle-daemon-auto-upgrade", "upgrade-preserves-config", "old-generation-removable"] }, null, 2)}\n`);
} finally {
  if (profile) {
    await manager.stop(profile).catch(() => {});
    await manager.ssh.run(profile, `rm -rf -- ${remoteRoot}`).catch(() => {});
  }
  await rm(localRoot, { recursive: true, force: true });
}
if (completed) process.exit(0);

async function readCurrent() {
  const result = await manager.ssh.run(profile, `readlink -f ${remoteRoot}/current`);
  if (result.code !== 0) throw new Error(`readlink current failed: ${result.stderr}`);
  return result.stdout.trim();
}
function assert(condition, message) { if (!condition) throw new Error(`Upgrade E2E failed: ${message}`); }
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required (a directory holding the previous artifact.json and runtime archive)`); return value; }
