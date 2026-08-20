// Covers the two decisions that make remote history usable: what a listing does
// to the stored rows, and what opening a session actually has to download.
// Both run against the compiled main output with no Electron and no SSH host.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dir = await mkdtemp(path.join(tmpdir(), "jasmine-remote-sessions-"));
const dbPath = path.join(dir, "jasmine.sqlite");
let db;

const PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE = "22222222-2222-4222-8222-222222222222";

function listing(overrides) {
  return {
    profileId: PROFILE,
    sessionId: "session-a",
    cwd: "/srv/application",
    name: null,
    preview: "refactor the auth middleware",
    turnCount: 3,
    remoteCreatedAt: "2026-08-18T09:00:00.000Z",
    remoteUpdatedAt: "2026-08-19T10:00:00.000Z",
    remoteSizeBytes: 4096,
    headerFingerprint: "fingerprint-a",
    ...overrides
  };
}

try {
  const remotes = await import("../../dist/main/main/db/repositories/remotes.js");
  const transcript = await import("../../dist/main/main/services/remoteTranscript.js");
  const migrations = await import("../../dist/main/main/db/migrations.js");
  const schemas = await import("../../dist/main/shared/schemas.js");

  db = new DatabaseSync(dbPath);
  migrations.migrateDatabase(db, () => "2026-08-20T00:00:00.000Z");

  // --- a listing writes what the host has, and only that -------------------
  remotes.upsertRemoteSessions(db, [
    listing({}),
    listing({ sessionId: "session-b", cwd: "/srv/etl", preview: "backfill the warehouse" })
  ], "2026-08-20T00:00:00.000Z");

  let rows = remotes.listRemoteSessions(db, PROFILE);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.state === "remote"), true, "a listed session has metadata only until it is opened");
  assert.equal(rows.find((row) => row.sessionId === "session-a").title, "refactor the auth middleware",
    "an unnamed session falls back to its first user message");

  // Discovered working directories are what the workspace tree is built from.
  assert.deepEqual(remotes.listRemoteSessionCwds(db, PROFILE), ["/srv/application", "/srv/etl"]);

  // --- downloading a copy moves the row to cached --------------------------
  remotes.updateRemoteSessionCache(db, {
    profileId: PROFILE,
    sessionId: "session-a",
    cachedBytes: 4096,
    cachedFingerprint: "fingerprint-a",
    transcriptPath: path.join(dir, "session-a.jsonl"),
    syncedAt: "2026-08-20T00:05:00.000Z",
    remoteSizeBytes: 4096
  });
  assert.equal(remotes.getRemoteSession(db, PROFILE, "session-a").state, "cached");

  // A later listing must not clobber the local copy it knows nothing about.
  remotes.upsertRemoteSessions(db, [listing({ remoteUpdatedAt: "2026-08-19T11:00:00.000Z" })], "2026-08-20T00:06:00.000Z");
  const afterRelist = remotes.getRemoteSession(db, PROFILE, "session-a");
  assert.equal(afterRelist.cachedBytes, 4096);
  assert.equal(afterRelist.state, "cached", "an unchanged size keeps the copy current");

  // --- growth on the host makes the copy stale ------------------------------
  remotes.upsertRemoteSessions(db, [listing({ remoteSizeBytes: 9000 })], "2026-08-20T00:07:00.000Z");
  assert.equal(remotes.getRemoteSession(db, PROFILE, "session-a").state, "stale");

  // A rewritten header is stale even when the size did not grow: the cached
  // prefix is no longer the remote prefix.
  remotes.upsertRemoteSessions(db, [listing({ headerFingerprint: "fingerprint-rewritten" })], "2026-08-20T00:08:00.000Z");
  assert.equal(remotes.getRemoteSession(db, PROFILE, "session-a").state, "stale");

  // --- a session the host no longer reports stays readable ------------------
  remotes.markMissingRemoteSessions(db, PROFILE, ["session-b"], "2026-08-20T00:09:00.000Z");
  const gone = remotes.getRemoteSession(db, PROFILE, "session-a");
  assert.equal(gone.state, "gone");
  assert.equal(gone.cachedBytes, 4096, "the downloaded copy survives so it can still be read");
  assert.equal(remotes.getRemoteSession(db, PROFILE, "session-b").state, "remote");

  // Reappearing clears the flag rather than duplicating the row.
  remotes.upsertRemoteSessions(db, [listing({})], "2026-08-20T00:10:00.000Z");
  assert.equal(remotes.getRemoteSession(db, PROFILE, "session-a").state, "cached");
  assert.equal(remotes.listRemoteSessions(db, PROFILE).length, 2);

  // --- workspaces ----------------------------------------------------------
  const discovered = remotes.upsertRemoteWorkspace(db, { profileId: PROFILE, cwd: "/srv/application", source: "discovered" }, "2026-08-20T00:11:00.000Z");
  assert.equal(discovered.name, "application");
  assert.equal(discovered.sessionCount, 1);
  const promoted = remotes.upsertRemoteWorkspace(db, { profileId: PROFILE, cwd: "/srv/application", name: "App", source: "manual" }, "2026-08-20T00:12:00.000Z");
  assert.equal(promoted.id, discovered.id, "adding a directory that was already discovered must not duplicate it");
  assert.equal(promoted.source, "manual", "a directory the user added by hand is no longer only a discovery");
  assert.equal(promoted.name, "App");

  // The same directory on a different profile is a different workspace: two
  // profiles for one host own separate remote trees.
  const otherWorkspace = remotes.upsertRemoteWorkspace(db, { profileId: OTHER_PROFILE, cwd: "/srv/application", source: "manual" }, "2026-08-20T00:13:00.000Z");
  assert.notEqual(otherWorkspace.id, discovered.id);
  assert.equal(remotes.listRemoteWorkspaces(db, PROFILE).length, 1);
  assert.equal(remotes.listRemoteWorkspaces(db).length, 2);

  // --- removing a profile hands back the files it owns ----------------------
  const removedPaths = remotes.removeRemoteProfileData(db, PROFILE);
  assert.deepEqual(removedPaths, [path.join(dir, "session-a.jsonl")]);
  assert.equal(remotes.listRemoteSessions(db, PROFILE).length, 0);
  assert.equal(remotes.listRemoteWorkspaces(db, PROFILE).length, 0);
  assert.equal(remotes.listRemoteWorkspaces(db, OTHER_PROFILE).length, 1, "one profile's removal must not touch another's");

  // --- what opening a session has to download -------------------------------
  const base = {
    cachedBytes: 4096,
    cachedFingerprint: "fingerprint-a",
    headerFingerprint: "fingerprint-a",
    remoteSizeBytes: 4096,
    transcriptExists: true,
    missing: false
  };
  assert.deepEqual(transcript.resolveSessionSyncPlan(base), { mode: "cached" },
    "a copy that matches the host is rendered with no network at all");
  assert.deepEqual(transcript.resolveSessionSyncPlan({ ...base, remoteSizeBytes: 9000 }), { mode: "append", fromOffset: 4096 },
    "growth is fetched from where the local copy ends");
  assert.deepEqual(transcript.resolveSessionSyncPlan({ ...base, headerFingerprint: "fingerprint-rewritten" }), { mode: "full", reason: "fingerprint" },
    "a rewritten prefix cannot be resumed into");
  assert.deepEqual(transcript.resolveSessionSyncPlan({ ...base, remoteSizeBytes: 100 }), { mode: "full", reason: "truncated" });
  assert.deepEqual(transcript.resolveSessionSyncPlan({ ...base, transcriptExists: false }), { mode: "full", reason: "absent" });
  assert.deepEqual(transcript.resolveSessionSyncPlan({ ...base, cachedBytes: 0 }), { mode: "full", reason: "absent" });
  assert.deepEqual(transcript.resolveSessionSyncPlan(base, { refetch: true }), { mode: "full", reason: "requested" });
  assert.deepEqual(transcript.resolveSessionSyncPlan({ ...base, missing: true, remoteSizeBytes: 9000 }), { mode: "cached" },
    "a session removed on the host is read from the local copy, not fetched again");
  // No size from the last listing is not a reason to redownload; resume and let
  // the host report the end.
  assert.deepEqual(transcript.resolveSessionSyncPlan({ ...base, remoteSizeBytes: null }), { mode: "append", fromOffset: 4096 });

  // --- the transcript projection -------------------------------------------
  const lines = [
    JSON.stringify({ type: "session", id: "session-a", cwd: "/srv/application", timestamp: "2026-08-18T09:00:00.000Z" }),
    JSON.stringify({ type: "message", id: "m1", timestamp: "2026-08-18T09:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "  refactor the auth middleware  " }] } }),
    JSON.stringify({ type: "message", id: "m2", timestamp: "2026-08-18T09:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "Bash" }, { type: "text", text: "npm test" }] } }),
    JSON.stringify({ type: "message", id: "m3", timestamp: "2026-08-18T09:00:03.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "consider the middleware order" }] } }),
    JSON.stringify({ type: "compaction", id: "m4", timestamp: "2026-08-18T09:00:04.000Z", summary: "earlier work summarized" }),
    "{\"type\":\"message\",\"half-written"
  ];
  const raw = `${lines.join("\n")}\n`;
  const entries = transcript.readTranscriptEntries(raw, Number.POSITIVE_INFINITY);
  assert.deepEqual(entries.map((entry) => entry.kind), ["user", "tool", "thinking", "compaction"],
    "the session header and a torn trailing line are not rows");
  assert.equal(entries[0].text, "refactor the auth middleware");
  assert.equal(entries[1].toolName, "Bash");
  assert.equal(entries.every((entry) => entry.appended === false), true);

  // Rows past the previous end are the ones the last sync brought in.
  const previousBytes = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`, "utf8");
  const afterAppend = transcript.readTranscriptEntries(raw, previousBytes);
  assert.deepEqual(afterAppend.map((entry) => entry.appended), [false, true, true, true]);

  // --- request validation ---------------------------------------------------
  assert.throws(() => schemas.remoteProfileCreateSchema.parse({ name: "ops box", sshHost: "ops-box", networkMode: "remote-direct" }),
    "a profile name pi-remote would reject must not reach the store");
  assert.throws(() => schemas.remoteProfileCreateSchema.parse({ name: "ops-box", sshHost: "-oProxyCommand=evil", networkMode: "remote-direct" }),
    "a host that reads as an ssh option must be refused before an argument is built");
  assert.throws(() => schemas.remoteWorkspaceAddSchema.parse({ profileId: PROFILE, cwd: "relative/path" }));
  assert.throws(() => schemas.remoteProfileCreateSchema.parse({ name: "ops-box", sshHost: "ops-box", networkMode: "sideways" }));
  const parsed = schemas.remoteProfileCreateSchema.parse({
    name: "ops-box",
    sshHost: "ops-box",
    networkMode: "client-proxy",
    upstreamProxyEnv: "HTTPS_PROXY",
    defaultCwd: "/srv/application"
  });
  assert.equal(parsed.upstreamProxyEnv, "HTTPS_PROXY");
  assert.throws(() => schemas.remoteProfileCreateSchema.parse({
    name: "ops-box",
    sshHost: "ops-box",
    networkMode: "client-proxy",
    upstreamProxyEnv: "https://proxy.internal:8080"
  }), "a proxy URL must stay on this machine; only its variable name travels");

  console.log("remote session projection checks passed");
} finally {
  db?.close();
  await rm(dir, { recursive: true, force: true });
}
