// Covers the two decisions that make remote history usable: what a listing does
// to the stored rows, and what opening a session actually has to download.
// Both run against the compiled main output with no Electron and no SSH host.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  const remoteRun = await import("../../dist/main/main/services/remoteSessionRun.js");
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

  // A session that vanishes before it was ever opened has nothing local behind
  // it, so keeping the row would offer a read-only copy that does not exist.
  remotes.upsertRemoteSessions(db, [
    listing({}),
    listing({ sessionId: "session-b", cwd: "/srv/etl" }),
    listing({ sessionId: "session-never-opened", cwd: "/srv/etl" })
  ], "2026-08-20T00:09:30.000Z");
  assert.equal(remotes.getRemoteSession(db, PROFILE, "session-never-opened").state, "remote");
  remotes.markMissingRemoteSessions(db, PROFILE, ["session-a", "session-b"], "2026-08-20T00:09:40.000Z");
  assert.equal(remotes.getRemoteSession(db, PROFILE, "session-never-opened"), null,
    "an uncached session the host dropped is removed rather than shown as a local copy");

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

  // A discovered workspace exists only because sessions pointed at it. Once the
  // host has none left, the row is an empty entry nothing can fill.
  const throwaway = remotes.upsertRemoteWorkspace(db, { profileId: PROFILE, cwd: "/srv/gone", source: "discovered" }, "2026-08-20T00:12:30.000Z");
  assert.equal(remotes.getRemoteWorkspace(db, throwaway.id).cwd, "/srv/gone");
  remotes.pruneDiscoveredRemoteWorkspaces(db, PROFILE, remotes.listRemoteSessionCwds(db, PROFILE));
  assert.equal(remotes.getRemoteWorkspace(db, throwaway.id), null,
    "a discovered directory the host no longer has sessions for stops being a workspace");
  assert.equal(remotes.getRemoteWorkspace(db, promoted.id).id, promoted.id,
    "a directory the user added by hand is a stated intention and survives");

  // Removing a workspace has to outlive the next reconciliation. The host still
  // has sessions in that directory, so a plain delete would be undone -- along
  // with the name and pinned state the user had set.
  const removable = remotes.upsertRemoteWorkspace(db, { profileId: PROFILE, cwd: "/srv/application", source: "discovered" }, "2026-08-20T00:12:40.000Z");
  remotes.updateRemoteWorkspace(db, { id: removable.id, pinned: true, name: "Pinned name" }, "2026-08-20T00:12:41.000Z");
  remotes.removeRemoteWorkspace(db, removable.id, "2026-08-20T00:12:42.000Z");
  assert.equal(remotes.getRemoteWorkspace(db, removable.id), null);
  remotes.upsertRemoteWorkspace(db, { profileId: PROFILE, cwd: "/srv/application", source: "discovered" }, "2026-08-20T00:12:43.000Z");
  assert.equal(remotes.getRemoteWorkspace(db, removable.id), null,
    "rediscovery must not undo a removal the user performed");
  assert.equal(remotes.listRemoteWorkspaces(db, PROFILE).some((workspace) => workspace.cwd === "/srv/application"), false);

  // Adding the same directory by hand is the user reversing that decision, and
  // restores the row they had configured rather than starting a new one.
  const restored = remotes.upsertRemoteWorkspace(db, { profileId: PROFILE, cwd: "/srv/application", source: "manual" }, "2026-08-20T00:12:44.000Z");
  assert.equal(restored.id, removable.id);
  assert.equal(restored.pinned, true, "the pinned state the user set survives the round trip");
  assert.equal(restored.name, "Pinned name");

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
  // m2 carries a call and text, and each block is its own row in the order the
  // model produced them.
  assert.deepEqual(entries.map((entry) => entry.kind), ["user", "tool", "assistant", "thinking", "compaction"],
    "the session header and a torn trailing line are not rows");
  assert.equal(entries[0].text, "refactor the auth middleware");
  assert.equal(entries[1].toolName, "Bash");
  assert.equal(entries[2].text, "npm test");
  assert.equal(entries.every((entry) => entry.appended === false), true);

  // Rows past the previous end are the ones the last sync brought in.
  const previousBytes = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`, "utf8");
  const afterAppend = transcript.readTranscriptEntries(raw, previousBytes);
  // Both entries m2 projects into are past the previous end, so both are new.
  assert.deepEqual(afterAppend.map((entry) => entry.appended), [false, true, true, true, true]);

  // --- the incremental download is all-or-nothing ---------------------------
  // A read that fails partway must not leave a longer file behind: the next open
  // would resume from the stored offset and append the same range twice.
  const syncDir = path.join(dir, "sync");
  const transcriptPath = path.join(syncDir, "session.jsonl");
  const chunk = (text, offset, size, fingerprint = "fp-a", eof = false) => ({
    offset,
    bytes: Buffer.byteLength(text, "utf8"),
    size,
    data: Buffer.from(text, "utf8").toString("base64"),
    headerFingerprint: fingerprint,
    eof
  });
  const head = "{\"type\":\"session\",\"id\":\"session-sync\"}\n";
  const tailOne = "{\"type\":\"message\",\"id\":\"m1\"}\n";
  const tailTwo = "{\"type\":\"message\",\"id\":\"m2\"}\n";
  const headBytes = Buffer.byteLength(head, "utf8");
  const oneBytes = Buffer.byteLength(tailOne, "utf8");
  const twoBytes = Buffer.byteLength(tailTwo, "utf8");
  const total = headBytes + oneBytes + twoBytes;
  const tooLarge = () => Object.assign(new Error("too large"), { code: "session-too-large" });

  // First download of a session that arrives in two chunks.
  let requested = [];
  let first = await transcript.syncSessionFile({
    transcriptPath,
    fromOffset: 0,
    expectedFingerprint: null,
    maxSyncBytes: 1024 * 1024,
    onTooLarge: tooLarge,
    readChunk: async (offset) => {
      requested.push(offset);
      return offset === 0
        ? chunk(head + tailOne, 0, total)
        : chunk(tailTwo, offset, total, "fp-a", true);
    }
  });
  assert.equal(first.offset, total);
  assert.equal(first.fetchedBytes, total);
  assert.equal(first.restarted, false);
  assert.equal(await readFile(transcriptPath, "utf8"), head + tailOne + tailTwo);
  assert.deepEqual(requested, [0, headBytes + oneBytes]);

  // A later read fails: the published copy and its bytes must be untouched, and
  // no staging file may survive.
  await assert.rejects(() => transcript.syncSessionFile({
    transcriptPath,
    fromOffset: total,
    expectedFingerprint: "fp-a",
    maxSyncBytes: 1024 * 1024,
    onTooLarge: tooLarge,
    readChunk: async (offset) => {
      if (offset === total) return chunk("{\"type\":\"message\",\"id\":\"m3\"}\n", offset, total + 100);
      throw new Error("ssh died mid-download");
    }
  }), /ssh died mid-download/u);
  assert.equal(await readFile(transcriptPath, "utf8"), head + tailOne + tailTwo,
    "a failed sync must not publish the bytes it did manage to read");
  await assert.rejects(() => stat(`${transcriptPath}.partial`), (error) => error?.code === "ENOENT");

  // Resuming reads from where the local copy ends, not from a stored number.
  requested = [];
  const resumed = await transcript.syncSessionFile({
    transcriptPath,
    fromOffset: 1,
    expectedFingerprint: "fp-a",
    maxSyncBytes: 1024 * 1024,
    onTooLarge: tooLarge,
    readChunk: async (offset) => {
      requested.push(offset);
      return chunk(tailTwo, offset, total + twoBytes, "fp-a", true);
    }
  });
  assert.deepEqual(requested, [total], "the resume point comes from the staged file size");
  assert.equal(resumed.fetchedBytes, twoBytes);
  assert.equal(await readFile(transcriptPath, "utf8"), head + tailOne + tailTwo + tailTwo);

  // A half-written trailing record is cut back to the last whole line before
  // anything is appended after it.
  const tornPath = path.join(syncDir, "torn.jsonl");
  await writeFile(tornPath, `${head}{"type":"message","id":"half`, "utf8");
  requested = [];
  await transcript.syncSessionFile({
    transcriptPath: tornPath,
    fromOffset: 999,
    expectedFingerprint: "fp-a",
    maxSyncBytes: 1024 * 1024,
    onTooLarge: tooLarge,
    readChunk: async (offset) => {
      requested.push(offset);
      return chunk(tailOne, offset, headBytes + oneBytes, "fp-a", true);
    }
  });
  assert.deepEqual(requested, [headBytes], "the torn record is dropped rather than resumed into");
  assert.equal(await readFile(tornPath, "utf8"), head + tailOne);

  // A remote file that was rewritten mid-download restarts instead of splicing
  // two different transcripts together.
  const rewrittenPath = path.join(syncDir, "rewritten.jsonl");
  let served = 0;
  const rewritten = await transcript.syncSessionFile({
    transcriptPath: rewrittenPath,
    fromOffset: 0,
    expectedFingerprint: null,
    maxSyncBytes: 1024 * 1024,
    onTooLarge: tooLarge,
    readChunk: async (offset) => {
      served += 1;
      if (served === 1) return chunk(head, 0, total, "fp-a");
      if (served === 2) return chunk("{\"type\":\"session\",\"id\":\"rewritten\"}\n", offset, twoBytes, "fp-b");
      return chunk("{\"type\":\"session\",\"id\":\"rewritten\"}\n", 0, twoBytes, "fp-b", true);
    }
  });
  assert.equal(rewritten.restarted, true);
  assert.equal(rewritten.fingerprint, "fp-b");
  assert.equal(await readFile(rewrittenPath, "utf8"), "{\"type\":\"session\",\"id\":\"rewritten\"}\n",
    "the bytes from the previous file identity are discarded, not kept as a prefix");

  // A cursor the host rejects falls back to a full download once.
  const staleCursorPath = path.join(syncDir, "stale.jsonl");
  await writeFile(staleCursorPath, head, "utf8");
  let refused = false;
  const recovered = await transcript.syncSessionFile({
    transcriptPath: staleCursorPath,
    fromOffset: headBytes,
    expectedFingerprint: "fp-a",
    maxSyncBytes: 1024 * 1024,
    onTooLarge: tooLarge,
    readChunk: async (offset) => {
      if (offset > 0 && !refused) {
        refused = true;
        throw Object.assign(new Error("past end"), { code: "session-offset-past-end" });
      }
      return chunk(tailOne, offset, oneBytes, "fp-a", true);
    }
  });
  assert.equal(recovered.restarted, true);
  assert.equal(await readFile(staleCursorPath, "utf8"), tailOne);

  // The remote file can be replaced between the listing that decided to resume
  // and the first resumed read, so that first chunk is checked against the
  // fingerprint the local copy was built from rather than trusted.
  const replacedPath = path.join(syncDir, "replaced.jsonl");
  await writeFile(replacedPath, head, "utf8");
  requested = [];
  const replaced = await transcript.syncSessionFile({
    transcriptPath: replacedPath,
    fromOffset: headBytes,
    expectedFingerprint: "fp-a",
    maxSyncBytes: 1024 * 1024,
    onTooLarge: tooLarge,
    readChunk: async (offset) => {
      requested.push(offset);
      // The host is serving a different file now.
      return chunk(tailTwo, offset, twoBytes, "fp-replaced", true);
    }
  });
  assert.deepEqual(requested, [headBytes, 0], "the mismatch is caught on the first resumed chunk, not after it is written");
  assert.equal(replaced.restarted, true);
  assert.equal(await readFile(replacedPath, "utf8"), tailTwo,
    "bytes from the replacement are never appended onto the previous file's prefix");

  // Without a fingerprint there is nothing to check the first chunk against, so
  // resuming is refused rather than done blind.
  const unverifiablePath = path.join(syncDir, "unverifiable.jsonl");
  await writeFile(unverifiablePath, head, "utf8");
  requested = [];
  const unverifiable = await transcript.syncSessionFile({
    transcriptPath: unverifiablePath,
    fromOffset: headBytes,
    expectedFingerprint: null,
    maxSyncBytes: 1024 * 1024,
    onTooLarge: tooLarge,
    readChunk: async (offset) => {
      requested.push(offset);
      return chunk(tailOne, offset, oneBytes, "fp-a", true);
    }
  });
  assert.deepEqual(requested, [0]);
  assert.equal(unverifiable.restarted, true);

  // The size cap is on the mirror, not on one visit's download: a session that
  // grows a little at a time would otherwise pass every open and still end up
  // unbounded on disk and in memory when it is read back.
  const cappedPath = path.join(syncDir, "capped.jsonl");
  await writeFile(cappedPath, head, "utf8");
  await assert.rejects(() => transcript.syncSessionFile({
    transcriptPath: cappedPath,
    fromOffset: headBytes,
    expectedFingerprint: "fp-a",
    maxSyncBytes: headBytes + 4,
    onTooLarge: tooLarge,
    readChunk: async (offset) => chunk(tailOne, offset, headBytes + oneBytes, "fp-a", true)
  }), (error) => error?.code === "session-too-large");
  assert.equal(await readFile(cappedPath, "utf8"), head, "refusing the range leaves the previous copy alone");

  // Two opens of one session share a staging file. Selecting a session, leaving
  // before its read answers, and selecting it again is enough to run both at
  // once, and interleaved staging publishes a spliced transcript or fails an
  // open whose staging file the other call renamed away.
  const sharedPath = path.join(syncDir, "shared.jsonl");
  let inFlight = 0;
  let overlapped = false;
  const concurrentRead = async (offset) => {
    inFlight += 1;
    if (inFlight > 1) overlapped = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return chunk(head + tailOne, offset, headBytes + oneBytes, "fp-a", true);
  };
  const both = await Promise.all([
    transcript.syncSessionFile({
      transcriptPath: sharedPath, fromOffset: 0, expectedFingerprint: null,
      maxSyncBytes: 1024 * 1024, onTooLarge: tooLarge, readChunk: concurrentRead
    }),
    transcript.syncSessionFile({
      transcriptPath: sharedPath, fromOffset: 0, expectedFingerprint: null,
      maxSyncBytes: 1024 * 1024, onTooLarge: tooLarge, readChunk: concurrentRead
    })
  ]);
  assert.equal(overlapped, false, "the second sync waits for the first rather than sharing its staging file");
  assert.equal(await readFile(sharedPath, "utf8"), head + tailOne);
  for (const result of both) assert.equal(result.offset, headBytes + oneBytes);
  await assert.rejects(() => stat(`${sharedPath}.partial`), (error) => error?.code === "ENOENT");

  // --- transcript projection ------------------------------------------------
  // A reasoning model's turn is a thinking block followed by text or a tool
  // call. Keeping only one kind per message renders the history as though the
  // model never reasoned.
  const reasoned = transcript.parseTranscriptLine(JSON.stringify({
    type: "message",
    id: "m-reasoned",
    timestamp: "2026-08-20T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "the failing test is the cache key" },
        { type: "text", text: "Rewriting the cache key." }
      ]
    }
  }), false);
  assert.deepEqual(reasoned.map((item) => item.kind), ["thinking", "assistant"]);
  assert.equal(reasoned[0].text, "the failing test is the cache key");
  assert.equal(reasoned[1].text, "Rewriting the cache key.");
  assert.equal(new Set(reasoned.map((item) => item.id)).size, 2, "two entries from one record need two keys");

  const reasonedCall = transcript.parseTranscriptLine(JSON.stringify({
    type: "message",
    id: "m-call",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "read the file first" },
        { type: "toolCall", name: "read_file" }
      ]
    }
  }), false);
  assert.deepEqual(reasonedCall.map((item) => item.kind), ["thinking", "tool"]);
  assert.equal(reasonedCall[1].toolName, "read_file");
  assert.deepEqual(transcript.parseTranscriptLine("{not json", false), [], "an unreadable line is dropped, not thrown");

  // A batch of parallel calls is several blocks in one record. Collapsing them
  // to one tool name would render a batch of four reads as a single call.
  const batched = transcript.parseTranscriptLine(JSON.stringify({
    type: "message",
    id: "m-batch",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Reading both files." },
        { type: "toolCall", name: "read_file" },
        { type: "toolCall", name: "grep" }
      ]
    }
  }), false);
  assert.deepEqual(batched.map((item) => item.kind), ["assistant", "tool", "tool"]);
  assert.deepEqual(batched.map((item) => item.toolName), [null, "read_file", "grep"]);
  assert.equal(new Set(batched.map((item) => item.id)).size, 3);

  // Text that arrived in several parts is still one entry: only a change of kind
  // starts a new one.
  const split = transcript.parseTranscriptLine(JSON.stringify({
    type: "message",
    id: "m-split",
    message: { role: "assistant", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }
  }), false);
  assert.deepEqual(split.map((item) => item.text), ["one\ntwo"]);
  assert.equal(split[0].id, "m-split", "a single entry keeps the record's own id");

  // A workspace is keyed by its directory, and the host reports its own
  // canonical spelling for every session it lists. A default cwd typed with a
  // trailing or doubled slash, or with dot segments, has to reduce to that same
  // key -- otherwise the first reconciliation discovers the canonical form as a
  // second, duplicate workspace for the directory the user already configured.
  assert.equal(transcript.normalizeRemotePath("/srv/application/"), "/srv/application");
  assert.equal(transcript.normalizeRemotePath("/srv//application"), "/srv/application");
  assert.equal(transcript.normalizeRemotePath("  /srv/application//  "), "/srv/application");
  assert.equal(transcript.normalizeRemotePath("/srv/./application"), "/srv/application");
  assert.equal(transcript.normalizeRemotePath("/srv/app/../application"), "/srv/application");
  assert.equal(transcript.normalizeRemotePath("/"), "/", "the root keeps its only slash");
  assert.equal(transcript.normalizeRemotePath("//"), "/");
  assert.equal(transcript.normalizeRemotePath("/.."), "/", "no spelling escapes above the root");

  // A prompt waiter subscribes before send, ignores buffered history, and only
  // settles for the new agent run. This is the lifecycle the renderer's single
  // long-running IPC request depends on.
  let promptListener;
  let promptUnsubscribed = false;
  const promptWaiter = remoteRun.waitForRemotePromptSettled({
    eventCursor: 4,
    subscribe(listener) {
      promptListener = listener;
      return () => { promptUnsubscribed = true; };
    }
  }, 1_000);
  promptListener({ seq: 4, type: "rpc.message", data: { type: "agent_settled" } });
  assert.equal(promptUnsubscribed, false, "a buffered settlement cannot finish the new prompt");
  promptListener({ seq: 5, type: "rpc.message", data: { type: "agent_settled" } });
  await promptWaiter.promise;
  assert.equal(promptUnsubscribed, true);

  let disconnectListener;
  const disconnected = remoteRun.waitForRemotePromptSettled({
    eventCursor: 0,
    subscribe(listener) {
      disconnectListener = listener;
      return () => {};
    }
  }, 1_000);
  disconnectListener({ seq: 1, type: "transport.disconnected" });
  await assert.rejects(disconnected.promise, (error) => error?.code === "daemon-disconnected");
  assert.equal(remoteRun.isDefinitePromptRejection({ code: "pi-rpc-failed" }), true);
  assert.equal(remoteRun.isDefinitePromptRejection({ code: "daemon-disconnected" }), false);

  const startCalls = [];
  let startListener;
  const startedSessionId = await remoteRun.startManagedRemoteSession({
    async openSession(_profile, options) {
      startCalls.push(["open", options]);
      return {
        eventCursor: 0,
        subscribe(listener) { startListener = listener; return () => { startCalls.push(["unsubscribe"]); }; },
        async createSession(cwd) { startCalls.push(["create", cwd]); return "created-session"; },
        async prompt(text, _images, onAccepted) {
          startCalls.push(["prompt", text]);
          onAccepted?.();
          queueMicrotask(() => startListener({ seq: 1, type: "rpc.message", data: { type: "agent_settled" } }));
        },
        async close(options) { startCalls.push(["close", options]); }
      };
    }
  }, {}, "/srv/application", "inspect the workspace", {
    onPromptAccepted() { startCalls.push(["accepted"]); }
  });
  assert.equal(startedSessionId, "created-session");
  assert.deepEqual(startCalls, [
    ["open", { cwd: "/srv/application" }],
    ["create", "/srv/application"],
    ["prompt", "inspect the workspace"],
    ["accepted"],
    ["unsubscribe"],
    ["close", { abort: false }]
  ], "the first prompt creates and settles the new session before normal non-aborting cleanup");

  const promptCalls = [];
  let runListener;
  await remoteRun.promptManagedRemoteSession({
    async openSession(_profile, options) {
      promptCalls.push(["open", options]);
      return {
        eventCursor: 0,
        subscribe(listener) { runListener = listener; return () => { promptCalls.push(["unsubscribe"]); }; },
        async prompt(text) {
          promptCalls.push(["prompt", text]);
          queueMicrotask(() => runListener({ seq: 1, type: "rpc.message", data: { type: "agent_settled" } }));
        },
        async close(options) { promptCalls.push(["close", options]); }
      };
    }
  }, {}, "created-session", "inspect the workspace");
  assert.deepEqual(promptCalls, [
    ["open", { sessionId: "created-session" }],
    ["prompt", "inspect the workspace"],
    ["unsubscribe"],
    ["close", { abort: false }]
  ], "a prompt waits for settlement before closing the managed port without aborting remote work");

  const timeoutCalls = [];
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(remoteRun.promptManagedRemoteSession({
      async openSession(_profile, options) {
        timeoutCalls.push(["open", options]);
        return {
          eventCursor: 0,
          subscribe() { return () => { timeoutCalls.push(["unsubscribe"]); }; },
          async prompt(_text, _images, onAccepted) { timeoutCalls.push(["prompt"]); onAccepted?.(); },
          async detach() { timeoutCalls.push(["detach"]); },
          async close() { timeoutCalls.push(["close"]); }
        };
      }
    }, {}, "slow-session", "long task", {
      timeoutMs: 5,
      onPromptAccepted() { timeoutCalls.push(["accepted"]); }
    }), (error) => error?.code === "prompt-timeout");
  } finally {
    clearTimeout(keepAlive);
  }
  assert.deepEqual(timeoutCalls, [
    ["open", { sessionId: "slow-session" }],
    ["prompt"],
    ["accepted"],
    ["unsubscribe"],
    ["detach"]
  ], "a local timeout detaches without stopping the daemon-owned remote process");

  const disconnectCalls = [];
  let transportListener;
  await assert.rejects(remoteRun.promptManagedRemoteSession({
    async openSession() {
      return {
        eventCursor: 0,
        subscribe(listener) { transportListener = listener; return () => { disconnectCalls.push(["unsubscribe"]); }; },
        async prompt(_text, _images, onAccepted) {
          disconnectCalls.push(["prompt"]);
          onAccepted?.();
          queueMicrotask(() => transportListener({ seq: 1, type: "transport.disconnected" }));
        },
        async detach() { disconnectCalls.push(["detach"]); },
        async close() { disconnectCalls.push(["close"]); }
      };
    }
  }, {}, "disconnect-session", "long task", {
    onPromptAccepted() { disconnectCalls.push(["accepted"]); }
  }), (error) => error?.code === "daemon-disconnected");
  assert.deepEqual(disconnectCalls, [
    ["prompt"],
    ["accepted"],
    ["unsubscribe"],
    ["detach"]
  ], "a transport disconnect after acceptance detaches without closing detached resources");

  // Session reconciliation has its own renderer spinner. Reusing the profile's
  // connection-checking state here is what made an idle Connected host appear
  // to probe itself repeatedly whenever the tree or route refreshed.
  const remoteProfileServiceSource = await readFile(path.join(process.cwd(), "src/main/services/remoteProfiles.ts"), "utf8");
  const refreshSessionsBody = /async refreshSessions[\s\S]*?(?=\n  \/\*\* Creates the session)/u.exec(remoteProfileServiceSource)?.[0] ?? "";
  assert.ok(refreshSessionsBody, "refreshSessions implementation must remain visible to the regression guard");
  assert.doesNotMatch(refreshSessionsBody, /state:\s*"checking"/u,
    "background session sync must not masquerade as a connection check");
  assert.match(refreshSessionsBody, /listSessionsWithRuntime/u,
    "session refresh must carry the daemon active-RPC snapshot used for restart recovery");
  assert.match(remoteProfileServiceSource, /recoverActiveOperation\(profile, runtimeInfo\)/u);
  const stopProfileBody = /async stopProfile[\s\S]*?(?=\n  listStatuses)/u.exec(remoteProfileServiceSource)?.[0] ?? "";
  assert.match(stopProfileBody, /await active\.done/u,
    "profile stop must wait until the active prompt handler has released its reservation");
  const abortSessionBody = /async abortSession[\s\S]*?(?=\n  async openSession)/u.exec(remoteProfileServiceSource)?.[0] ?? "";
  assert.doesNotMatch(abortSessionBody, /releaseOperation/u,
    "the abort handler must never release an opening or attached operation owned by its request");
  assert.match(abortSessionBody, /operation\.phase === "detached"[\s\S]*monitorDetachedOperation/u,
    "a detached Stop hands ownership to the daemon monitor");
  assert.doesNotMatch(abortSessionBody, /operation\.port = null/u,
    "an abort transport failure must retain the port's detached egress release handle");
  assert.match(remoteProfileServiceSource, /inspectRuntime\(profile, \{ install: false \}\)/u,
    "detached work must stay monitored from daemon state rather than a stale client sequence");
  assert.match(remoteProfileServiceSource, /reconnectDetachedEgress\(profile, recoveredRuntimeInfo\)/u,
    "a recovered client-proxy operation must restore its stable egress lease");
  assert.match(remoteProfileServiceSource, /releaseDetachedResources/u,
    "the detached monitor owns final release of retained local egress resources");
  const detachedMonitorStart = remoteProfileServiceSource.indexOf("private monitorDetachedOperation");
  const detachedMonitorEnd = remoteProfileServiceSource.indexOf("\n}\n\nlet service", detachedMonitorStart);
  const detachedMonitorBody = remoteProfileServiceSource.slice(detachedMonitorStart, detachedMonitorEnd);
  assert.ok(detachedMonitorBody.indexOf("if (operation.abortRequested)") < detachedMonitorBody.indexOf('profile.network.mode === "client-proxy"'),
    "a detached Stop must run before any attempt to restore client-proxy egress");
  assert.match(remoteProfileServiceSource, /if \(operation\.promptAccepted && !isDefinitePromptRejection\(error\)\)[\s\S]*pending: true/u,
    "post-acceptance synchronization failures must not be exposed as retryable pre-send failures");
  assert.match(remoteProfileServiceSource, /this\.startupRecovery = this\.recoverActiveOperationsOnStartup\(\)/u,
    "daemon-owned work must be discovered when the service starts, without waiting for navigation");
  assert.match(remoteProfileServiceSource, /async startSession[\s\S]*?await this\.awaitProfileStartupRecovery\(profileId\)/u,
    "new sessions must wait for their profile's startup recovery");
  assert.match(remoteProfileServiceSource, /async promptSession[\s\S]*?await this\.awaitProfileStartupRecovery\(profileId\)/u,
    "existing-session prompts must wait for their profile's startup recovery");
  assert.match(remoteProfileServiceSource, /async removeProfile[\s\S]*?await this\.awaitProfileStartupRecovery\(profileId\)/u,
    "profile removal must not race a startup recovery that can still reserve it");
  assert.doesNotMatch(remoteProfileServiceSource, /await Promise\.all\(profiles\.map/u,
    "one offline host must not globally gate unrelated profile operations");
  assert.equal(remoteProfileServiceSource.match(/promptAccepted && !isDefinitePromptRejection\(error\)/gu)?.length, 2,
    "both new and existing sessions must keep an explicit Pi rejection retryable in the composer");
  assert.match(remoteProfileServiceSource, /void this\.retryStartupRecovery\(profile\)/u,
    "transient startup outages must hand off to an unbounded background recovery loop");
  assert.match(remoteProfileServiceSource, /cancelledStartupRecovery/u,
    "removing a profile must cancel its persistent background recovery");

  const appSource = await readFile(path.join(process.cwd(), "src/renderer/App.tsx"), "utf8");
  const openWorkspaceHandler = /onOpenRemoteWorkspace[\s\S]*?(?=\n    onOpenRemoteSession)/u.exec(appSource)?.[0] ?? "";
  assert.ok(openWorkspaceHandler, "the remote workspace route handler must remain covered");
  assert.doesNotMatch(openWorkspaceHandler, /openProfile/u,
    "workspace navigation must let the route effect own the one background refresh");

  // --- request validation ---------------------------------------------------
  assert.throws(() => schemas.remoteProfileCreateSchema.parse({ name: "ops box", sshHost: "ops-box", networkMode: "remote-direct" }),
    "a profile name pi-remote would reject must not reach the store");
  assert.throws(() => schemas.remoteProfileCreateSchema.parse({ name: "ops-box", sshHost: "-oProxyCommand=evil", networkMode: "remote-direct" }),
    "a host that reads as an ssh option must be refused before an argument is built");
  assert.throws(() => schemas.remoteWorkspaceAddSchema.parse({ profileId: PROFILE, cwd: "relative/path" }));
  assert.throws(() => schemas.remoteSessionStartSchema.parse({ profileId: PROFILE, cwd: "relative/path", text: "inspect" }));
  assert.throws(() => schemas.remoteSessionStartSchema.parse({ profileId: PROFILE, cwd: "/srv/application", text: "   " }));
  assert.throws(() => schemas.remoteSessionPromptSchema.parse({ profileId: PROFILE, sessionId: "session-a", text: "   " }));
  assert.deepEqual(schemas.remoteSessionPromptSchema.parse({
    profileId: PROFILE,
    sessionId: "session-a",
    text: "  inspect the workspace  "
  }), { profileId: PROFILE, sessionId: "session-a", text: "inspect the workspace" });
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
