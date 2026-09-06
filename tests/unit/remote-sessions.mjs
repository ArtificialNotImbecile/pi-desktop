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

  // A tool call and its result are two records but one thing that happened:
  // the reader shows one row carrying what the tool was asked and what came
  // back, and a failed result is marked rather than read as ordinary output.
  const toolRows = transcript.readTranscriptEntries([
    JSON.stringify({ type: "message", id: "m-ask", message: { role: "user", content: "list the directory" } }),
    JSON.stringify({ type: "message", id: "m-do", message: { role: "assistant", content: [
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la /srv" } },
      { type: "toolCall", id: "call-2", name: "read", arguments: { path: "/srv/app/README.md" } }
    ] } }),
    JSON.stringify({ type: "message", id: "m-result-1", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "total 0" }] } }),
    JSON.stringify({ type: "message", id: "m-result-2", message: { role: "toolResult", toolCallId: "call-2", toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }] } }),
    JSON.stringify({ type: "message", id: "m-fail", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid api key" } }),
    JSON.stringify({ type: "message", id: "m-stopped", message: { role: "assistant", content: [{ type: "text", text: "1 2 3" }], stopReason: "aborted" } })
  ].join("\n"), Number.POSITIVE_INFINITY);
  assert.deepEqual(toolRows.map((row) => row.kind), ["user", "tool", "tool", "notice", "assistant", "notice"],
    "each result folds into the call it answers instead of standing as a second row");
  assert.equal(toolRows[1].toolArgs, "ls -la /srv", "a shell call is summarized by its command");
  assert.equal(toolRows[1].text, "total 0");
  assert.equal(toolRows[1].isError, false);
  assert.equal(toolRows[2].toolArgs, "/srv/app/README.md", "a file tool is summarized by its path");
  assert.equal(toolRows[2].isError, true, "a result Pi flagged as an error stays flagged");
  assert.deepEqual([toolRows[3].notice, toolRows[3].text, toolRows[3].isError], ["error", "401 invalid api key", true],
    "a failed turn keeps the provider's reason visible");
  assert.deepEqual([toolRows[5].notice, toolRows[5].text, toolRows[5].isError], ["aborted", "", false],
    "a stopped turn says so without reading as a failure");
  assert.equal(new Set(toolRows.map((row) => row.id)).size, toolRows.length, "every row keeps a distinct key");

  // A result whose call was never seen -- history trimmed above it -- still has
  // somewhere to go rather than vanishing.
  const orphanRows = transcript.readTranscriptEntries(JSON.stringify({
    type: "message", id: "m-orphan", message: { role: "toolResult", toolCallId: "call-x", toolName: "bash", content: [{ type: "text", text: "late output" }] }
  }), Number.POSITIVE_INFINITY);
  assert.deepEqual(orphanRows.map((row) => [row.kind, row.toolName, row.text]), [["tool", "bash", "late output"]]);

  // --- live turn projection -------------------------------------------------
  // The main process assembles what a running turn has produced from Pi's RPC
  // deltas. Text accumulates per content block, tool execution lands on the
  // block that announced the call, and the completed message is authoritative.
  const liveTurn = await import("../../dist/main/main/services/remoteLiveTurn.js");
  const aggregator = new liveTurn.RemoteLiveTurnAggregator({ profileId: PROFILE, sessionId: null, cwd: "/srv/application", prompt: "run the tests", startedAt: "2026-08-21T00:00:00.000Z" });
  assert.equal(aggregator.snapshot().state, "running");
  assert.equal(aggregator.handle({ type: "agent_start" }), false, "a lifecycle marker with nothing to draw is not a change");
  assert.equal(aggregator.handle({ type: "message_start", message: { role: "assistant", content: [] } }), false);
  assert.equal(aggregator.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }), true);
  aggregator.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "check the " } });
  aggregator.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "test runner" } });
  aggregator.handle({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
  aggregator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Running " } });
  aggregator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "them now." } });
  aggregator.handle({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 } });
  aggregator.handle({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: { id: "call-9", name: "bash", arguments: { command: "npm test" } } } });
  let live = aggregator.snapshot();
  assert.deepEqual(live.entries.map((entry) => [entry.kind, entry.text, entry.toolName, entry.toolArgs, entry.toolState]), [
    ["thinking", "check the test runner", null, null, null],
    ["assistant", "Running them now.", null, null, null],
    ["tool", "", "bash", "npm test", "running"]
  ], "deltas accumulate per block in the order the model produced them");

  aggregator.handle({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "check the test runner" },
    { type: "text", text: "Running them now. Stand by." },
    { type: "toolCall", id: "call-9", name: "bash", arguments: { command: "npm test" } }
  ] } });
  aggregator.handle({ type: "tool_execution_start", toolCallId: "call-9", toolName: "bash", args: { command: "npm test" } });
  aggregator.handle({ type: "tool_execution_update", toolCallId: "call-9", toolName: "bash", partialResult: { content: [{ type: "text", text: "> jest\n" }] } });
  live = aggregator.snapshot();
  assert.equal(live.entries[1].text, "Running them now. Stand by.", "the completed message replaces the accumulated text");
  assert.equal(live.entries.length, 3, "execution events land on the announced call rather than adding a row");
  assert.equal(live.entries[2].text, "> jest\n");
  aggregator.handle({ type: "tool_execution_end", toolCallId: "call-9", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "1 test failed" }] } });
  aggregator.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  aggregator.handle({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  aggregator.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "One test fails." } });
  aggregator.handle({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider returned 429", content: [{ type: "text", text: "One test fails." }] } });
  assert.equal(aggregator.handle({ type: "agent_settled" }), true);
  live = aggregator.snapshot();
  assert.deepEqual(live.entries.map((entry) => [entry.kind, entry.text, entry.toolState]), [
    ["thinking", "check the test runner", null],
    ["assistant", "Running them now. Stand by.", null],
    ["tool", "1 test failed", "error"],
    ["assistant", "One test fails.", null]
  ], "a second message follows the first without disturbing settled rows");
  assert.equal(live.state, "settled");
  assert.equal(live.error, "provider returned 429", "a failed turn carries the provider's reason");
  assert.equal(live.entries.length, new Set(live.entries.map((entry) => entry.id)).size, "every live row keeps a distinct key");
  assert.ok(live.version > 10, "each change bumps the version the renderer orders snapshots by");

  // Pi retries transient provider errors itself: the retry's message supersedes
  // the failure notice, and a failure Pi recorded no words for is still marked.
  const retried = new liveTurn.RemoteLiveTurnAggregator({ profileId: PROFILE, sessionId: "s", cwd: "/srv", prompt: "p" });
  retried.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  retried.handle({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } });
  assert.equal(retried.snapshot().error, "", "a failure without a provider message is still a failure");
  retried.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  retried.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second try" } });
  retried.handle({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "second try" }] } });
  assert.equal(retried.snapshot().error, null, "a new attempt clears the earlier failure");
  assert.deepEqual(retried.snapshot().entries.map((entry) => entry.text), ["second try"]);

  // A block whose kind changes at the same content index leaves no stray row
  // behind once the completed message replaces what was streamed.
  const reindexed = new liveTurn.RemoteLiveTurnAggregator({ profileId: PROFILE, sessionId: "s", cwd: "/srv", prompt: "p" });
  reindexed.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  reindexed.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } });
  reindexed.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer" } });
  reindexed.handle({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }] } });
  assert.deepEqual(reindexed.snapshot().entries.map((entry) => [entry.kind, entry.text]), [["assistant", "answer"]]);

  // An execution whose call was never announced still gets a row of its own.
  const orphanTurn = new liveTurn.RemoteLiveTurnAggregator({ profileId: PROFILE, sessionId: "s", cwd: "/srv", prompt: "p" });
  orphanTurn.handle({ type: "tool_execution_start", toolCallId: "call-lost", toolName: "read", args: { path: "/srv/x" } });
  assert.deepEqual(orphanTurn.snapshot().entries.map((entry) => [entry.kind, entry.toolName, entry.toolArgs, entry.toolState]), [["tool", "read", "/srv/x", "running"]]);

  assert.equal(liveTurn.summarizeToolArgs("grep", { pattern: "TODO", path: "/srv/app" }), "TODO · /srv/app");
  assert.equal(liveTurn.summarizeToolArgs("mystery", { a: 1 }), "{\"a\":1}", "an unknown tool still reads as something");
  assert.equal(liveTurn.summarizeToolArgs("bash", { command: `echo ${"x".repeat(400)}` }).length, 200, "a summary is one bounded line");

  // --- remote model configuration ------------------------------------------
  // The remote Pi has an isolated profile with no providers of its own. What is
  // pushed there is the provider Jasmine would run locally, in the two files
  // pi-remote's host command writes, with the credential kept separate.
  const modelConfig = await import("../../dist/main/main/services/remoteModelConfig.js");
  const provider = { providerName: "deepseek", apiKey: "sk-live-secret", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-v4-flash" };
  const piModel = {
    id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", api: "openai-completions", provider: "deepseek", baseUrl: provider.baseUrl,
    reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
    compat: { supportsStore: false, thinkingFormat: "deepseek" }
  };
  const payload = modelConfig.buildRemoteModelPayload(provider, piModel, "high");
  assert.deepEqual(payload.selection, { providerId: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" });
  assert.deepEqual(Object.keys(payload.config.models.providers), ["deepseek"]);
  const remoteProvider = payload.config.models.providers.deepseek;
  assert.equal(remoteProvider.baseUrl, provider.baseUrl);
  assert.equal(remoteProvider.api, "openai-completions");
  assert.equal("apiKey" in remoteProvider, false, "the credential travels through auth import, not models.json");
  assert.deepEqual(remoteProvider.models.map((model) => model.id), ["deepseek-v4-flash"]);
  assert.deepEqual(remoteProvider.models[0].thinkingLevelMap, piModel.thinkingLevelMap, "the model keeps the same thinking mapping as the local agent");
  assert.equal("provider" in remoteProvider.models[0], false, "provider-level facts are not repeated on the model entry");
  assert.deepEqual(payload.config.settings, { defaultProvider: "deepseek", defaultModel: "deepseek-v4-flash", defaultThinkingLevel: "high" });
  assert.deepEqual(payload.credential, { type: "api_key", key: "sk-live-secret" });
  assert.equal(JSON.stringify(payload.config).includes("sk-live-secret"), false, "the synced configuration never carries the key");

  const withoutThinking = modelConfig.buildRemoteModelPayload(provider, { ...piModel, reasoning: false }, "high");
  assert.deepEqual(withoutThinking.config.settings, { defaultProvider: "deepseek", defaultModel: "deepseek-v4-flash" },
    "a thinking level is only pinned for a model that reasons");
  assert.notEqual(withoutThinking.fingerprint, payload.fingerprint, "a changed model definition is a different payload");
  assert.notEqual(modelConfig.buildRemoteModelPayload({ ...provider, apiKey: "sk-rotated" }, piModel, "high").fingerprint, payload.fingerprint,
    "a rotated key must be pushed again even when the model is unchanged");
  assert.equal(modelConfig.buildRemoteModelPayload(provider, piModel, "high").fingerprint, payload.fingerprint, "the same input is the same payload");
  assert.equal(modelConfig.literalCredentialValue("$looks-like-env"), "$$looks-like-env", "Pi's environment-variable prefix is escaped");
  assert.equal(modelConfig.literalCredentialValue("!looks-like-command"), "$!looks-like-command", "Pi's shell-command prefix is escaped");
  assert.equal(modelConfig.literalCredentialValue("sk-plain"), "sk-plain");

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
        async prompt(text, _images, onAccepted, onDispatched) {
          startCalls.push(["prompt", text]);
          onDispatched?.();
          onAccepted?.();
          queueMicrotask(() => startListener({ seq: 1, type: "rpc.message", data: { type: "agent_settled" } }));
        },
        async close(options) { startCalls.push(["close", options]); }
      };
    }
  }, {}, "/srv/application", "inspect the workspace", {
    onPromptAccepted() { startCalls.push(["accepted"]); },
    onPromptDispatched() { startCalls.push(["dispatched"]); }
  });
  assert.equal(startedSessionId, "created-session");
  assert.deepEqual(startCalls, [
    ["open", { cwd: "/srv/application" }],
    ["create", "/srv/application"],
    ["prompt", "inspect the workspace"],
    ["dispatched"],
    ["accepted"],
    ["unsubscribe"],
    ["close", { abort: false }]
  ], "the first prompt creates and settles the new session before normal non-aborting cleanup");

  // With a model selected, the port is pinned to it after the session exists and
  // before the prompt goes out, and Pi's own events reach the live projection
  // -- minus anything replayed from before this prompt was armed.
  const pinnedCalls = [];
  const liveMessages = [];
  let pinnedListeners = [];
  await remoteRun.startManagedRemoteSession({
    async openSession() {
      return {
        eventCursor: 7,
        subscribe(listener) {
          pinnedListeners.push(listener);
          // Replayed history from before this prompt, delivered on subscribe
          // the way the real port does, must not reach the projection.
          listener({ seq: 3, type: "rpc.message", data: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stale" } } });
          return () => { pinnedListeners = pinnedListeners.filter((candidate) => candidate !== listener); };
        },
        async createSession(cwd) { pinnedCalls.push(["create", cwd]); return "pinned-session"; },
        async setModel(provider, modelId) { pinnedCalls.push(["setModel", provider, modelId]); },
        async setThinking(level) { pinnedCalls.push(["setThinking", level]); throw new Error("level unsupported"); },
        async prompt(text) {
          pinnedCalls.push(["prompt", text]);
          queueMicrotask(() => {
            for (const listener of pinnedListeners) listener({ seq: 8, type: "rpc.message", data: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fresh" } } });
            for (const listener of pinnedListeners) listener({ seq: 9, type: "rpc.message", data: { type: "agent_settled" } });
          });
        },
        async close(options) { pinnedCalls.push(["close", options]); }
      };
    }
  }, {}, "/srv/application", "pinned prompt", {
    model: { providerId: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" },
    onRpcMessage(message) { liveMessages.push(message.type === "agent_settled" ? "settled" : message.assistantMessageEvent?.delta); }
  });
  assert.deepEqual(pinnedCalls, [
    ["create", "/srv/application"],
    ["setModel", "deepseek", "deepseek-v4-flash"],
    ["setThinking", "high"],
    ["prompt", "pinned prompt"],
    ["close", { abort: false }]
  ], "the model is pinned between session creation and the prompt; a refused thinking level does not block the turn");
  assert.deepEqual(liveMessages, ["fresh", "settled"], "only events after the prompt was armed reach the live projection");
  assert.equal(pinnedListeners.length, 0, "the live subscription is released with the settlement waiter");

  // A model Pi refuses is a definite rejection: nothing was sent, so the draft
  // can come back and the port closes without aborting anything.
  const refusedCalls = [];
  await assert.rejects(remoteRun.promptManagedRemoteSession({
    async openSession() {
      return {
        eventCursor: 0,
        subscribe() { return () => {}; },
        async setModel() {
          refusedCalls.push(["setModel"]);
          const error = new Error("Model not found: deepseek/gone");
          error.code = "pi-rpc-failed";
          throw error;
        },
        async prompt() { refusedCalls.push(["prompt"]); },
        async detach() { refusedCalls.push(["detach"]); },
        async close(options) { refusedCalls.push(["close", options]); }
      };
    }
  }, {}, "refused-session", "never sent", {
    model: { providerId: "deepseek", modelId: "gone", thinkingLevel: null }
  }), (error) => remoteRun.isDefinitePromptRejection(error));
  assert.deepEqual(refusedCalls, [["setModel"], ["close", { abort: false }]], "a refused model never reaches the prompt");

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
          async prompt(_text, _images, onAccepted, onDispatched) { timeoutCalls.push(["prompt"]); onDispatched?.(); onAccepted?.(); },
          async detach() { timeoutCalls.push(["detach"]); },
          async close() { timeoutCalls.push(["close"]); }
        };
      }
    }, {}, "slow-session", "long task", {
      timeoutMs: 5,
      onPromptDispatched() { timeoutCalls.push(["dispatched"]); },
      onPromptAccepted() { timeoutCalls.push(["accepted"]); }
    }), (error) => error?.code === "prompt-timeout");
  } finally {
    clearTimeout(keepAlive);
  }
  assert.deepEqual(timeoutCalls, [
    ["open", { sessionId: "slow-session" }],
    ["prompt"],
    ["dispatched"],
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
        async prompt(_text, _images, onAccepted, onDispatched) {
          disconnectCalls.push(["prompt"]);
          onDispatched?.();
          onAccepted?.();
          queueMicrotask(() => transportListener({ seq: 1, type: "transport.disconnected" }));
        },
        async detach() { disconnectCalls.push(["detach"]); },
        async close() { disconnectCalls.push(["close"]); }
      };
    }
  }, {}, "disconnect-session", "long task", {
    onPromptDispatched() { disconnectCalls.push(["dispatched"]); },
    onPromptAccepted() { disconnectCalls.push(["accepted"]); }
  }), (error) => error?.code === "daemon-disconnected");
  assert.deepEqual(disconnectCalls, [
    ["prompt"],
    ["dispatched"],
    ["accepted"],
    ["unsubscribe"],
    ["detach"]
  ], "a transport disconnect after acceptance detaches without closing detached resources");

  const ambiguousCalls = [];
  await assert.rejects(remoteRun.promptManagedRemoteSession({
    async openSession() {
      return {
        eventCursor: 0,
        subscribe() { return () => {}; },
        async prompt(_text, _images, _onAccepted, onDispatched) {
          ambiguousCalls.push(["prompt"]);
          onDispatched?.();
          const error = new Error("daemon acknowledgement was lost");
          error.code = "daemon-disconnected";
          throw error;
        },
        async detach() { ambiguousCalls.push(["detach"]); },
        async close() { ambiguousCalls.push(["close"]); }
      };
    }
  }, {}, "ambiguous-session", "may already be running", {
    onPromptDispatched() { ambiguousCalls.push(["dispatched"]); },
    onPromptAccepted() { ambiguousCalls.push(["accepted"]); }
  }), (error) => error?.code === "daemon-disconnected");
  assert.deepEqual(ambiguousCalls, [
    ["prompt"],
    ["dispatched"],
    ["detach"]
  ], "a lost daemon acknowledgement preserves the distinct dispatched boundary");

  const prewriteCalls = [];
  await assert.rejects(remoteRun.promptManagedRemoteSession({
    async openSession() {
      return {
        eventCursor: 0,
        subscribe() { return () => {}; },
        async prompt() {
          prewriteCalls.push(["prompt"]);
          const error = new Error("disconnected before transport write");
          error.code = "daemon-disconnected";
          throw error;
        },
        async detach() { prewriteCalls.push(["detach"]); },
        async close() { prewriteCalls.push(["close"]); }
      };
    }
  }, {}, "prewrite-session", "not sent", {
    onPromptDispatched() { prewriteCalls.push(["dispatched"]); }
  }), (error) => error?.code === "daemon-disconnected");
  assert.deepEqual(prewriteCalls, [
    ["prompt"],
    ["detach"]
  ], "a disconnect before writable.write must not mark the prompt dispatched");

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
  assert.match(stopProfileBody, /await this\.awaitStopConfirmation\(active\)/u,
    "profile stop must wait until the active prompt handler has released its reservation");
  assert.doesNotMatch(stopProfileBody, /await active\.done/u,
    "a detached monitor that retries an unreachable host must not park profile Stop forever");
  assert.match(remoteProfileServiceSource, /private async awaitStopConfirmation[\s\S]*?Promise\.race\(\[\s*operation\.done/u,
    "the stop wait must race the operation against a bounded timer");
  assert.match(stopProfileBody, /cancelledStartupRecovery\.add\(profileId\)/u,
    "explicit Stop must cancel persistent startup recovery for its profile");
  assert.doesNotMatch(stopProfileBody, /await this\.awaitProfileStartupRecovery/u,
    "explicit Stop must not wait for an unbounded offline recovery gate");
  assert.match(stopProfileBody, /catch \(error\)[\s\S]*recoveryResumeRequested\.add\(profile\.id\)[\s\S]*resumeProfileStartupRecovery/u,
    "a failed Stop must resume the cancelled client-proxy recovery chain");
  assert.match(remoteProfileServiceSource, /while \(true\)[\s\S]*startupRecoveryByProfile\.get\(profileId\) === recovery/u,
    "Send must follow a recovery promise that is replaced after a failed Stop");
  const abortSessionBody = /async abortSession[\s\S]*?(?=\n  async openSession)/u.exec(remoteProfileServiceSource)?.[0] ?? "";
  assert.doesNotMatch(abortSessionBody, /releaseOperation/u,
    "the abort handler must never release an opening or attached operation owned by its request");
  assert.match(abortSessionBody, /operation\.phase === "detached"[\s\S]*monitorDetachedOperation/u,
    "a detached Stop hands ownership to the daemon monitor");
  assert.match(abortSessionBody, /startupRecoveryWaiters[\s\S]*cancelStartupRecoveryWaiters/u,
    "composer Stop must cancel a prompt waiting on startup recovery");
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
  assert.match(remoteProfileServiceSource, /operation\.promptDispatched && isDetachedPromptFailure\(error\)[\s\S]*pending: true/u,
    "post-acceptance synchronization failures must not be exposed as retryable pre-send failures");
  assert.match(remoteProfileServiceSource, /this\.startupRecovery = this\.recoverActiveOperationsOnStartup\(\)/u,
    "daemon-owned work must be discovered when the service starts, without waiting for navigation");
  assert.match(remoteProfileServiceSource, /async startSession[\s\S]*?awaitProfileStartupRecovery\(profileId, true\)/u,
    "new sessions must wait for their profile's startup recovery");
  assert.match(remoteProfileServiceSource, /async promptSession[\s\S]*?awaitProfileStartupRecovery\(profileId, true\)/u,
    "existing-session prompts must wait for their profile's startup recovery");
  assert.equal(remoteProfileServiceSource.match(/awaitProfileStartupRecovery\(profileId, true\)/gu)?.length, 2,
    "both new and existing submissions need a cancellable recovery gate");
  assert.match(remoteProfileServiceSource, /async removeProfile[\s\S]*?await this\.awaitProfileStartupRecovery\(profileId\)/u,
    "profile removal must not race a startup recovery that can still reserve it");
  assert.doesNotMatch(remoteProfileServiceSource, /await Promise\.all\(profiles\.map/u,
    "one offline host must not globally gate unrelated profile operations");
  assert.equal(remoteProfileServiceSource.match(/promptDispatched && isDetachedPromptFailure\(error\)/gu)?.length, 2,
    "both new and existing sessions must treat a lost delivery acknowledgement as pending");
  assert.match(detachedMonitorBody, /operation\.daemonId && info\.daemonId !== operation\.daemonId/u,
    "a detached prompt must fail explicitly when its daemon epoch changes");
  assert.match(detachedMonitorBody, /if \(!active\)[\s\S]*remote-rpc-vanished/u,
    "a missing RPC in the same daemon epoch must not be presented as normal settlement");
  assert.match(remoteProfileServiceSource, /await this\.retryStartupRecovery\(profile\.id\)/u,
    "both egress modes must remain inside their profile gate until the host answers");
  assert.doesNotMatch(remoteProfileServiceSource, /currentProfile\.network\.mode !== "client-proxy"/u,
    "remote-direct recovery must not be abandoned after an offline startup");
  assert.match(remoteProfileServiceSource, /currentProfile = await this\.store\.get\(profileId\)/u,
    "persistent recovery must reload profile edits before each SSH retry");
  assert.match(remoteProfileServiceSource, /cancelledStartupRecovery\.add\(profileId\)[\s\S]*await this\.awaitProfileStartupRecovery\(profileId\)/u,
    "profile removal must cancel an offline recovery before waiting for its gate");
  assert.match(remoteProfileServiceSource, /if \(!removed\)[\s\S]*scheduleProfileStartupRecovery\(currentProfile\)/u,
    "a failed local profile removal must restart startup recovery");
  assert.match(remoteProfileServiceSource, /cancelledStartupRecovery/u,
    "removing a profile must cancel its persistent background recovery");

  // The remote Pi has no model of its own. Both submission paths must give the
  // host the selected model before opening the port, and pin the port to it.
  const ensureModelBody = /private async ensureRemoteModel[\s\S]*?(?=\n  \/\*\*)/u.exec(remoteProfileServiceSource)?.[0] ?? "";
  assert.ok(ensureModelBody, "the remote model sync must remain visible to the regression guard");
  assert.match(ensureModelBody, /getRuntimeProvider\(this\.db, selection\.providerId, selection\.modelId\)/u,
    "the remote model is the one Jasmine would run a local turn with");
  assert.match(ensureModelBody, /syncModelConfig\(profile, payload\.config\)[\s\S]*authImport\(profile, payload\.selection\.providerId, payload\.credential\)/u,
    "models.json and the credential are pushed through pi-remote's own host commands");
  assert.match(ensureModelBody, /syncedModelFingerprints\.get\(profile\.id\) !== payload\.fingerprint/u,
    "an unchanged model must not be uploaded before every prompt");
  const startSessionBody = /async startSession\([\s\S]*?(?=\n  \/\*\* Runs one prompt)/u.exec(remoteProfileServiceSource)?.[0] ?? "";
  const promptSessionBody = /async promptSession\([\s\S]*?(?=\s+\/\*\*\s+\* Makes sure the host)/u.exec(remoteProfileServiceSource)?.[0] ?? "";
  for (const [name, body] of [["startSession", startSessionBody], ["promptSession", promptSessionBody]]) {
    assert.ok(body, `${name} implementation must remain visible to the regression guard`);
    assert.match(body, /const model = await this\.ensureRemoteModel\(profile, selection, operation\)/u,
      `${name} must give the host the selected model before opening the port`);
    assert.match(body, /\{\s+model,\s+onRpcMessage: live\.handle,/u,
      `${name} must pin the port to the model and feed the live projection`);
    assert.match(body, /live\.settle\(\)[\s\S]*refreshSessions\(profile\.id\)/u,
      `${name} must flush the settled live turn before reconciling the session listing`);
    assert.match(body, /finally \{\s*live\.close\(\)/u, `${name} must close the live turn however it ends`);
  }
  assert.match(remoteProfileServiceSource, /webContents\.send\("remotes:live-turn-changed", turn\)/u,
    "live snapshots reach every renderer window");

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
  // The model a turn should run with travels with the prompt, in the same shape
  // the chat composer sends, and an unknown effort is refused rather than passed on.
  assert.deepEqual(schemas.remoteSessionStartSchema.parse({
    profileId: PROFILE,
    cwd: "/srv/application",
    text: "inspect",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    reasoningEffort: "high"
  }), { profileId: PROFILE, cwd: "/srv/application", text: "inspect", providerId: "deepseek", modelId: "deepseek-v4-flash", reasoningEffort: "high" });
  assert.throws(() => schemas.remoteSessionPromptSchema.parse({ profileId: PROFILE, sessionId: "session-a", text: "inspect", reasoningEffort: "ultra" }));
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
