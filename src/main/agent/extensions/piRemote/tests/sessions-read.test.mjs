import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RemoteHostDaemon } from "../dist/daemon.js";
import { encodeJsonFrame, JsonFrameDecoder } from "../dist/framing.js";

const PROFILE_ID = "00000000-0000-4000-8000-000000000001";

test("sessions.list reports turn count, preview, size, and header fingerprint", async () => {
  const fixture = await sessionFixture();
  try {
    const sessions = await request(fixture, "sessions.list");
    // Sessions are found by walking the directory, so the nested one counts too.
    assert.deepEqual(sessions.map((session) => session.id).sort(), ["session-named", "session-nested", "session-plain"]);
    const named = sessions.find((session) => session.id === "session-named");
    assert.equal(named.name, "Renamed later");
    assert.equal(named.turnCount, 2);
    assert.equal(named.preview, "first user turn");
    assert.equal(named.cwd, "/srv/application");
    assert.equal(named.sizeBytes, Buffer.byteLength(fixture.namedContent, "utf8"));
    assert.match(named.headerFingerprint, /^[0-9a-f]{32}$/u);

    // An unnamed session is the common case, so its preview has to carry the row.
    const plain = sessions.find((session) => session.id === "session-plain");
    assert.equal(plain.name, undefined);
    assert.equal(plain.preview, "only turn here");
    assert.equal(plain.turnCount, 1);
  } finally {
    await fixture.dispose();
  }
});

test("a malformed line does not discard the session it appears in", async () => {
  const fixture = await sessionFixture();
  try {
    await writeFile(path.join(fixture.sessionDir, "torn.jsonl"), [
      JSON.stringify({ type: "session", id: "session-torn", cwd: "/srv/torn", timestamp: "2026-08-01T00:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content: "kept" } }),
      "{\"type\":\"message\",\"partial",
      ""
    ].join("\n"), "utf8");
    const sessions = await request(fixture, "sessions.list");
    const torn = sessions.find((session) => session.id === "session-torn");
    assert.equal(torn.preview, "kept", "a half-written trailing line is normal for a session being appended to");
    assert.equal(torn.turnCount, 1);
  } finally {
    await fixture.dispose();
  }
});

test("sessions.read returns a resumable byte range that reassembles into the whole file", async () => {
  const fixture = await sessionFixture();
  try {
    const total = Buffer.byteLength(fixture.namedContent, "utf8");
    const first = await request(fixture, "sessions.read", { id: "session-named", maxBytes: 40 });
    assert.equal(first.offset, 0);
    assert.equal(first.bytes, 40);
    assert.equal(first.size, total);
    assert.equal(first.eof, false);

    const rest = await request(fixture, "sessions.read", { id: "session-named", fromOffset: first.bytes });
    assert.equal(rest.offset, 40);
    assert.equal(rest.eof, true);
    assert.equal(rest.headerFingerprint, first.headerFingerprint);

    const joined = Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(rest.data, "base64")]).toString("utf8");
    assert.equal(joined, fixture.namedContent);
  } finally {
    await fixture.dispose();
  }
});

test("reading from the end of the file returns an empty chunk rather than an error", async () => {
  const fixture = await sessionFixture();
  try {
    const size = Buffer.byteLength(fixture.namedContent, "utf8");
    const chunk = await request(fixture, "sessions.read", { id: "session-named", fromOffset: size });
    assert.equal(chunk.bytes, 0);
    assert.equal(chunk.eof, true, "a caller polling an unchanged session must not have to treat that as failure");
  } finally {
    await fixture.dispose();
  }
});

test("an offset past the end is refused so a stale cursor cannot corrupt a cached transcript", async () => {
  const fixture = await sessionFixture();
  try {
    const error = await requestError(fixture, "sessions.read", { id: "session-named", fromOffset: 10_000_000 });
    assert.equal(error.code, "session-offset-past-end");
    assert.match(error.remediation, /offset 0/u);
  } finally {
    await fixture.dispose();
  }
});

test("sessions.read rejects an unknown session and validates its arguments", async () => {
  const fixture = await sessionFixture();
  try {
    assert.equal((await requestError(fixture, "sessions.read", { id: "session-missing" })).code, "session-not-found");
    assert.equal((await requestError(fixture, "sessions.read", {})).code, "session-id-invalid");
    assert.equal((await requestError(fixture, "sessions.read", { id: "session-named", fromOffset: -1 })).code, "fromOffset-invalid");
    assert.equal((await requestError(fixture, "sessions.read", { id: "session-named", maxBytes: 1.5 })).code, "maxBytes-invalid");
  } finally {
    await fixture.dispose();
  }
});

test("a session is located by its header id, not by a client-supplied path", async () => {
  const fixture = await sessionFixture();
  try {
    // The id is matched against session headers under the profile's own session
    // directory, so traversal shapes simply find nothing.
    assert.equal((await requestError(fixture, "sessions.read", { id: "../../../etc/passwd" })).code, "session-not-found");
    const nested = await request(fixture, "sessions.read", { id: "session-nested" });
    assert.equal(nested.eof, true);
    assert.match(Buffer.from(nested.data, "base64").toString("utf8"), /session-nested/u);
  } finally {
    await fixture.dispose();
  }
});

test("listing summarizes a session without holding the whole transcript", async () => {
  const fixture = await sessionFixture();
  try {
    // Records that straddle the scan's chunk boundary, and one line larger than
    // a whole chunk, are exactly what a naive line reader gets wrong.
    const filler = "x".repeat(200 * 1024);
    const lines = [
      JSON.stringify({ type: "session", id: "session-large", cwd: "/srv/large", timestamp: "2026-08-03T00:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "l1", parentId: null, timestamp: "2026-08-03T00:00:01.000Z", message: { role: "user", content: "první — a multi-byte preview" } }),
      JSON.stringify({ type: "message", id: "l2", parentId: "l1", timestamp: "2026-08-03T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: filler }] } })
    ];
    for (let index = 0; index < 40; index += 1) {
      lines.push(JSON.stringify({
        type: "message",
        id: `u${index}`,
        parentId: "l2",
        timestamp: "2026-08-03T00:00:03.000Z",
        message: { role: "user", content: `turn ${index} ${"y".repeat(4096)}` }
      }));
    }
    lines.push(JSON.stringify({ type: "session_info", id: "rename", parentId: null, timestamp: "2026-08-03T00:00:04.000Z", name: "Large history" }));
    const content = `${lines.join("\n")}\n`;
    await writeFile(path.join(fixture.sessionDir, "large.jsonl"), content, "utf8");

    const sessions = await request(fixture, "sessions.list");
    const large = sessions.find((session) => session.id === "session-large");
    assert.equal(large.name, "Large history", "the last rename still wins after a multi-chunk scan");
    assert.equal(large.turnCount, 41);
    assert.equal(large.preview, "první — a multi-byte preview",
      "a preview decoded across chunk boundaries keeps its characters intact");
    assert.equal(large.sizeBytes, Buffer.byteLength(content, "utf8"));
  } finally {
    await fixture.dispose();
  }
});

test("reading a host's sessions never installs the runtime by itself", async () => {
  const { ManagedRemoteRuntime } = await import("../dist/runtime.js");
  const profile = {
    id: "00000000-0000-4000-8000-000000000002",
    name: "fixture",
    sshHost: "host",
    network: { mode: "remote-direct", clientProxy: { noProxy: [], allowedPorts: [80, 443] } },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  // A host with no runtime: every probe and lifecycle command fails the way an
  // uninstalled remote root does.
  const manager = new ManagedRemoteRuntime({
    ssh: {
      run: async () => ({ code: 1, stdout: "", stderr: "no runtime" }),
      spawn() { throw new Error("browsing must not spawn an upload"); },
      probe: async () => { throw new Error("browsing must not probe for an install"); }
    }
  });

  for (const call of [
    () => manager.listSessions(profile, { install: false }),
    () => manager.readSession(profile, "session-any", { install: false })
  ]) {
    await assert.rejects(call, (error) => {
      assert.equal(error.code, "runtime-not-installed");
      assert.match(error.remediation, /Install the runtime/u);
      return true;
    });
  }
});

async function sessionFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-sessions-"));
  const profileRoot = path.join(root, "profile");
  const sessionDir = path.join(profileRoot, "sessions");
  await mkdir(path.join(sessionDir, "2026", "08"), { recursive: true });

  const namedContent = `${[
    JSON.stringify({ type: "session", id: "session-named", cwd: "/srv/application", timestamp: "2026-08-01T00:00:00.000Z" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first user turn" }] } }),
    JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-08-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "an answer" }] } }),
    JSON.stringify({ type: "message", id: "m3", parentId: "m2", timestamp: "2026-08-01T00:00:03.000Z", message: { role: "user", content: "second user turn" } }),
    JSON.stringify({ type: "session_info", id: "m4", parentId: "m3", timestamp: "2026-08-01T00:00:04.000Z", name: "Renamed later" })
  ].join("\n")}\n`;
  await writeFile(path.join(sessionDir, "named.jsonl"), namedContent, "utf8");

  await writeFile(path.join(sessionDir, "plain.jsonl"), `${[
    JSON.stringify({ type: "session", id: "session-plain", cwd: "/srv/etl", timestamp: "2026-07-01T00:00:00.000Z" }),
    JSON.stringify({ type: "message", id: "p1", parentId: null, timestamp: "2026-07-01T00:00:01.000Z", message: { role: "user", content: "only turn here" } })
  ].join("\n")}\n`, "utf8");

  await writeFile(path.join(sessionDir, "2026", "08", "nested.jsonl"), `${JSON.stringify({
    type: "session", id: "session-nested", cwd: "/srv/nested", timestamp: "2026-08-02T00:00:00.000Z"
  })}\n`, "utf8");

  const daemon = new RemoteHostDaemon({
    profileId: PROFILE_ID,
    paths: {
      remoteRoot: root,
      runtimeRoot: path.join(root, "runtime"),
      profileRoot,
      agentDir: path.join(profileRoot, "agent"),
      sessionDir,
      logDir: path.join(profileRoot, "logs"),
      runDir: path.join(profileRoot, "run"),
      socketPath: path.join(profileRoot, "run", "control.sock"),
      statusPath: path.join(profileRoot, "run", "status.json"),
      descriptorDir: path.join(profileRoot, "run", "descriptors"),
      piExecutable: path.join(root, "runtime", "bin", "pi"),
      tmuxExecutable: path.join(root, "runtime", "bin", "tmux")
    },
    artifactSha256: "a".repeat(64)
  });

  return {
    daemon,
    sessionDir,
    namedContent,
    dispose: () => rm(root, { recursive: true, force: true })
  };
}

async function dispatch(fixture, method, params) {
  const socket = fakeSocket();
  fixture.daemon.accept(socket);
  socket.emit("data", encodeJsonFrame({ type: "hello", version: 1, clientId: "fixture-client", afterSeq: 0 }));
  socket.emit("data", encodeJsonFrame({ type: "request", id: "request-1", method, ...(params === undefined ? {} : { params }) }));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const decoder = new JsonFrameDecoder();
    const messages = socket.writes.flatMap((chunk) => decoder.push(chunk));
    const response = messages.find((message) => message.type === "response" && message.id === "request-1");
    if (response) return response;
  }
  throw new Error(`daemon did not answer ${method}`);
}

async function request(fixture, method, params) {
  const response = await dispatch(fixture, method, params);
  assert.equal(response.ok, true, `expected ${method} to succeed: ${JSON.stringify(response.error)}`);
  return response.result;
}

async function requestError(fixture, method, params) {
  const response = await dispatch(fixture, method, params);
  assert.equal(response.ok, false, `expected ${method} to fail`);
  return response.error;
}

function fakeSocket() {
  const socket = new EventEmitter();
  socket.writes = [];
  socket.destroyed = false;
  socket.setKeepAlive = () => {};
  socket.write = (chunk) => { socket.writes.push(Buffer.from(chunk)); return true; };
  socket.end = () => socket.emit("close");
  socket.destroy = () => { socket.destroyed = true; socket.emit("close"); };
  return socket;
}
