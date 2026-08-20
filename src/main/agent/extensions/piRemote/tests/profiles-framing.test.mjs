import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JsonFrameDecoder, PiRemoteError, ProfileStore, encodeJsonFrame } from "../dist/index.js";
import { reclaimOwnedLock, removeOwnedLock, withOwnedFileLock } from "../dist/file-lock.js";

test("profile storage is atomic, versioned, isolated, and validates SSH/path input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-profile-"));
  const filePath = path.join(root, "profiles.json");
  try {
    const store = new ProfileStore(filePath);
    const profile = await store.add({
      name: "gpu-box",
      sshHost: "root@example.internal",
      sshPort: 4560,
      defaultCwd: "/srv/project",
      networkMode: "client-proxy",
      noProxy: ["db.internal", "127.0.0.1"],
      allowedPorts: [443, 80, 443],
      upstreamProxyEnv: "PI_REMOTE_UPSTREAM_PROXY"
    });
    assert.match(profile.id, /^[0-9a-f-]{36}$/u);
    assert.equal(profile.sshPort, 4560);
    assert.deepEqual(profile.network.clientProxy.allowedPorts, [80, 443]);
    assert.equal((await store.get("GPU-BOX")).id, profile.id);
    assert.equal((await store.list()).length, 1);
    const persisted = await readFile(filePath, "utf8");
    assert.match(persisted, /"version": 1/u);
    assert.doesNotMatch(persisted, /private.key|api.key|proxy.token/iu);
    await assert.rejects(() => store.add({ name: "gpu-box", sshHost: "other" }), /already exists/u);
    await assert.rejects(() => store.add({ name: "bad host", sshHost: "host" }), /Profile names/u);
    await assert.rejects(() => store.add({ name: "bad-host", sshHost: "-oProxyCommand=evil" }), /SSH host/u);
    await assert.rejects(() => store.add({ name: "bad-port", sshHost: "host", sshPort: 70000 }), /SSH port/u);
    await assert.rejects(() => store.add({ name: "bad-cwd", sshHost: "host", defaultCwd: "relative" }), /absolute POSIX/u);
    const removed = await store.remove(profile.id);
    assert.equal(removed.name, "gpu-box");
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent profile mutations are serialized without lost updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-profile-lock-"));
  const filePath = path.join(root, "profiles.json");
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => new ProfileStore(filePath).add({ name: `host-${index}`, sshHost: `host-${index}` })));
    const stored = await new ProfileStore(filePath).list();
    assert.equal(stored.length, 12);
    assert.equal(new Set(stored.map((profile) => profile.name)).size, 12);
    await Promise.all(stored.slice(0, 6).map((profile) => new ProfileStore(filePath).remove(profile.id)));
    assert.equal((await new ProfileStore(filePath).list()).length, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale lock recovery preserves replacement owners across shared lock users", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-stale-lock-"));
  const filePath = path.join(root, "profiles.json");
  const lockPath = `${filePath}.lock`;
  const abandonedOwner = "owner-00000000-0000-4000-8000-000000000001.lock";
  try {
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, abandonedOwner), "abandoned");
    await utimes(path.join(lockPath, abandonedOwner), new Date(0), new Date(0));
    await Promise.all(Array.from({ length: 8 }, (_, index) => new ProfileStore(filePath).add({ name: `recovered-${index}`, sshHost: `host-${index}` })));
    assert.equal((await new ProfileStore(filePath).list()).length, 8);

    const replacementLock = path.join(root, "replacement-lock");
    const oldOwner = "owner-00000000-0000-4000-8000-000000000002.lock";
    const newOwner = "owner-00000000-0000-4000-8000-000000000003.lock";
    await mkdir(replacementLock);
    await writeFile(path.join(replacementLock, oldOwner), "old-owner");
    await rm(replacementLock, { recursive: true });
    await mkdir(replacementLock);
    await writeFile(path.join(replacementLock, newOwner), "new-owner");
    assert.equal(await removeOwnedLock(replacementLock, oldOwner), false);
    assert.equal(await readFile(path.join(replacementLock, newOwner), "utf8"), "new-owner");

    const heartbeatLock = path.join(root, "heartbeat-lock");
    const heartbeatOwner = "owner-00000000-0000-4000-8000-000000000005.lock";
    await mkdir(heartbeatLock);
    const heartbeatPath = path.join(heartbeatLock, heartbeatOwner);
    await writeFile(heartbeatPath, "live-owner");
    await utimes(heartbeatPath, new Date(0), new Date(0));
    const observedMtimeMs = (await stat(heartbeatPath)).mtimeMs;
    const refreshed = new Date();
    await utimes(heartbeatPath, refreshed, refreshed);
    assert.equal(await reclaimOwnedLock(heartbeatLock, heartbeatOwner, observedMtimeMs, Date.now() - 30_000), false);
    assert.equal(await readFile(heartbeatPath, "utf8"), "live-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lock acquisition retries once after the final poll", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-final-poll-"));
  const lockPath = path.join(root, "state.lock");
  let contender;
  try {
    await withOwnedFileLock(lockPath, async () => {
      contender = withOwnedFileLock(lockPath, async () => "acquired", {
        attempts: 1,
        pollMs: 50,
        staleMs: 30_000
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(await contender, "acquired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lock acquisition reclaims an owner that becomes stale during the final poll", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-final-stale-"));
  const lockPath = path.join(root, "state.lock");
  const abandonedOwner = path.join(lockPath, "owner-00000000-0000-4000-8000-000000000006.lock");
  try {
    await mkdir(lockPath);
    await writeFile(abandonedOwner, "abandoned");
    const nearlyStale = new Date(Date.now() - 50);
    await utimes(abandonedOwner, nearlyStale, nearlyStale);
    const acquired = await withOwnedFileLock(lockPath, async () => "acquired", {
      attempts: 1,
      pollMs: 100,
      staleMs: 100
    });
    assert.equal(acquired, "acquired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("length-prefixed JSON framing handles arbitrary chunks and Unicode separators", () => {
  const values = [
    { type: "hello", text: "line\u2028separator\u2029kept" },
    { type: "event", nested: { ok: true } }
  ];
  const wire = Buffer.concat(values.map((value) => Buffer.from(encodeJsonFrame(value))));
  const decoder = new JsonFrameDecoder();
  const decoded = [];
  for (let index = 0; index < wire.length; index += index % 7 + 1) {
    decoded.push(...decoder.push(wire.subarray(index, Math.min(wire.length, index + index % 7 + 1))));
  }
  decoder.end();
  assert.deepEqual(decoded, values);
});

test("framing fails closed on zero, oversized, malformed, and truncated frames", () => {
  assert.throws(() => encodeJsonFrame("x".repeat(20), 10), PiRemoteError);
  assert.throws(() => new JsonFrameDecoder().push(Buffer.alloc(4)), /invalid protocol frame length/u);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(101, 0);
  assert.throws(() => new JsonFrameDecoder(100).push(oversized), /invalid protocol frame length/u);
  const malformed = Buffer.alloc(5);
  malformed.writeUInt32BE(1, 0);
  malformed[4] = 0xff;
  assert.throws(() => new JsonFrameDecoder().push(malformed), /not valid UTF-8 JSON/u);
  const truncated = new JsonFrameDecoder();
  truncated.push(encodeJsonFrame({ ok: true }).subarray(0, 5));
  assert.throws(() => truncated.end(), /middle of a frame/u);
});
