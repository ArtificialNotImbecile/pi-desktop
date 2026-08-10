import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const packageDir = path.resolve(import.meta.dirname, "..");
const extensionModule = await import(pathToFileURL(path.join(packageDir, "dist", "index.js")).href);
const {
  FILE_CHANGES_ENTRY_TYPE,
  FILE_CHANGES_SCHEMA_VERSION,
  createFileChangeExtension,
  default: defaultExtension
} = extensionModule;

test("defaults to managed-tools-only and performs no project scan when no managed tool runs", async () => {
  await withTempDirectory(async (root) => {
    const unrelated = path.join(root, "unrelated-1gb.zip");
    await writeFile(unrelated, "");
    await truncate(unrelated, 1024 * 1024 * 1024);
    const harness = createTrackingHarness(root);
    const started = performance.now();
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("agent_settled", { type: "agent_settled" });
    const elapsed = performance.now() - started;

    const capture = harness.capture();
    assert.equal(capture.coverage.trackingMode, "managed-tools-only");
    assert.equal(capture.coverage.status, "complete");
    assert.deepEqual(capture.coverage.roots, []);
    assert.deepEqual(capture.changes, []);
    assert.ok(elapsed < 1_000, `no-op tracking took ${elapsed.toFixed(0)}ms`);
  });
});

test("captures an added write target without reading unrelated large files", async () => {
  await withTempDirectory(async (root) => {
    const unrelated = path.join(root, "archive.zip");
    await writeFile(unrelated, "");
    await truncate(unrelated, 1024 * 1024 * 1024);
    const target = path.join(root, "created.txt");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await successfulTool(harness, "write", target, async () => writeFile(target, "created\n"));
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.deepEqual(capture.changes.map(({ path: filePath, status }) => [filePath, status]), [["created.txt", "added"]]);
    assert.equal(capture.changes[0].text.after.text, "created\n");
    assert.equal(capture.coverage.roots.length, 1);
    assert.equal(capture.coverage.roots[0].scope, "file");
    assert.equal(capture.coverage.issues.some((issue) => /archive\.zip/.test(issue.message)), false);
  });
});

test("captures a managed edit with a Git-style before/after diff", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "edited.txt");
    await writeFile(target, "before\n");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await successfulTool(harness, "edit", target, async () => writeFile(target, "after\n"));
    await harness.emit("agent_settled", { type: "agent_settled" });

    const change = harness.capture().changes[0];
    assert.equal(change.status, "modified");
    assert.equal(change.text.before.text, "before\n");
    assert.equal(change.text.after.text, "after\n");
    assert.match(change.text.unifiedDiff.text, /-before/);
    assert.match(change.text.unifiedDiff.text, /\+after/);
  });
});

test("uses the first managed baseline across repeated edits and suppresses a net revert", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "sequence.txt");
    await writeFile(target, "initial\n");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await successfulTool(harness, "edit", target, async () => writeFile(target, "middle\n"), "edit-1");
    await successfulTool(harness, "edit", target, async () => writeFile(target, "initial\n"), "edit-2");
    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.deepEqual(harness.capture().changes, []);
  });
});

test("does not report a failed managed tool call", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "failed.txt");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("tool_call", toolCall("write", target, "failed-write"));
    await harness.emit("tool_result", toolResult("write", target, "failed-write", true));
    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.deepEqual(harness.capture().changes, []);
  });
});

test("managed-tools-only records Bash as intentionally untracked without partial coverage", async () => {
  await withTempDirectory(async (root) => {
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("tool_call", { type: "tool_call", toolName: "bash", toolCallId: "bash-1", input: { command: "echo x" } });
    await writeFile(path.join(root, "shell-only.txt"), "not observed\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.equal(capture.coverage.status, "complete");
    assert.equal(capture.coverage.bashCoverage, "not-tracked");
    assert.equal(capture.coverage.bashInvoked, true);
    assert.deepEqual(capture.changes, []);
    assert.equal(capture.coverage.warnings.some((warning) => /maximum total bytes/i.test(warning)), false);
  });
});

test("an oversized managed target is bounded and reported without scanning the directory", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "large.bin");
    await writeFile(target, "");
    await truncate(target, 64 * 1024 * 1024);
    const harness = createTrackingHarness(root, { maxContentBytes: 1024 * 1024 });
    const started = performance.now();
    await harness.emit("agent_start", { type: "agent_start" });
    await successfulTool(harness, "edit", target, async () => truncate(target, 64 * 1024 * 1024 + 1));
    await harness.emit("agent_settled", { type: "agent_settled" });
    const elapsed = performance.now() - started;

    const capture = harness.capture();
    assert.equal(capture.changes.length, 1);
    assert.equal(capture.changes[0].status, "modified");
    assert.equal(capture.changes[0].contentOmitted, true);
    assert.equal(capture.coverage.status, "partial");
    assert.match(capture.coverage.reason, /observed-file byte limit/i);
    assert.ok(elapsed < 3_000, `bounded oversized target took ${elapsed.toFixed(0)}ms`);
  });
});

test("watcher mode observes create, update, and delete events without an initial checkpoint", async () => {
  await withTempDirectory(async (root) => {
    const updated = path.join(root, "updated.txt");
    const deleted = path.join(root, "deleted.txt");
    await writeFile(updated, "before\n");
    await writeFile(deleted, "delete\n");
    const harness = createTrackingHarness(root, { trackingMode: "watcher", watchRoot: root });
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "created.txt"), "created\n");
    await writeFile(updated, "after\n");
    await rm(deleted);
    await delay(500);
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.equal(capture.coverage.trackingMode, "watcher");
    assert.equal(capture.coverage.bashCoverage, "watcher-observed");
    assert.deepEqual(capture.changes.map(({ path: filePath, status }) => [filePath, status]), [
      ["created.txt", "added"],
      ["deleted.txt", "deleted"],
      ["updated.txt", "modified"]
    ]);
    const changed = capture.changes.find((item) => item.path === "updated.txt");
    assert.equal(changed.before, null);
    assert.equal(changed.text.after.text, "after\n");
    assert.equal(changed.text.unifiedDiff, undefined);
  });
});

test("managed evidence wins over a duplicate watcher event", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "both.txt");
    await writeFile(target, "before\n");
    const harness = createTrackingHarness(root, { trackingMode: "watcher", watchRoot: root });
    await harness.emit("agent_start", { type: "agent_start" });
    await successfulTool(harness, "edit", target, async () => writeFile(target, "after\n"));
    await delay(300);
    await harness.emit("agent_settled", { type: "agent_settled" });
    const capture = harness.capture();
    assert.equal(capture.changes.length, 1);
    assert.equal(capture.changes[0].text.before.text, "before\n");
    assert.match(capture.changes[0].text.unifiedDiff.text, /-before/);
  });
});

test("sensitive managed files retain metadata but never preview bytes or diffs", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, ".env");
    await writeFile(target, "TOKEN=before\n");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await successfulTool(harness, "edit", target, async () => writeFile(target, "TOKEN=after\n"));
    await harness.emit("agent_settled", { type: "agent_settled" });
    const change = harness.capture().changes[0];
    assert.equal(change.redacted, true);
    assert.equal(change.text, undefined);
    assert.match(change.before.sha256, /^[a-f0-9]{64}$/);
  });
});

test("default CLI entry is managed-only, metadata-only, and supports an external manifest opt-in", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "visible.txt");
    const harness = createHarness(defaultExtension, root);
    await harness.emit("agent_start", { type: "agent_start" });
    await successfulTool(harness, "write", target, async () => writeFile(target, "source stays out of entry\n"));
    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.equal(harness.entries[0].customType, FILE_CHANGES_ENTRY_TYPE);
    assert.equal(harness.entries[0].data.schemaVersion, FILE_CHANGES_SCHEMA_VERSION);
    assert.equal(harness.entries[0].data.coverage.trackingMode, "managed-tools-only");
    assert.equal(JSON.stringify(harness.entries[0]).includes("source stays out"), false);
    assert.equal(harness.entries[0].data.manifestPath, null);
    await assert.rejects(access(path.join(root, ".pi", "file-changes")), { code: "ENOENT" });

    await withTempDirectory(async (manifestDirectory) => {
      const previous = process.env.PI_FILE_CHANGES_MANIFEST_DIR;
      process.env.PI_FILE_CHANGES_MANIFEST_DIR = manifestDirectory;
      try {
        const optedIn = createHarness(defaultExtension, root);
        await optedIn.emit("agent_start", { type: "agent_start" });
        await successfulTool(optedIn, "edit", target, async () => writeFile(target, "manifest content\n"));
        await optedIn.emit("agent_settled", { type: "agent_settled" });
        const manifestPath = optedIn.entries[0].data.manifestPath;
        await access(manifestPath);
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        assert.equal(manifest.changes[0].text.after.text, "manifest content\n");
      } finally {
        if (previous === undefined) delete process.env.PI_FILE_CHANGES_MANIFEST_DIR;
        else process.env.PI_FILE_CHANGES_MANIFEST_DIR = previous;
      }
    });
  });
});

async function successfulTool(harness, toolName, target, mutate, id = `${toolName}-${Math.random()}`) {
  await harness.emit("tool_call", toolCall(toolName, target, id));
  await mutate();
  await harness.emit("tool_result", toolResult(toolName, target, id, false));
}

function toolCall(toolName, target, id) {
  return { type: "tool_call", toolName, toolCallId: id, input: { path: target } };
}

function toolResult(toolName, target, id, isError) {
  return { type: "tool_result", toolName, toolCallId: id, input: { path: target }, content: [], details: undefined, isError };
}

function createHarness(extension, cwd, captureTarget = []) {
  const handlers = new Map();
  const entries = [];
  const pi = {
    on(name, handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    }
  };
  const ctx = { cwd, mode: "json", hasUI: false };
  extension(pi);
  return {
    entries,
    async emit(name, event) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
      if (name === "agent_settled" && captureTarget.length === 0 && entries[0]?.data?.manifestPath) {
        captureTarget.push(JSON.parse(await readFile(entries[0].data.manifestPath, "utf8")));
      }
    },
    capture() {
      assert.equal(captureTarget.length, 1, "expected exactly one capture");
      return captureTarget[0];
    }
  };
}

function createTrackingHarness(cwd, options = {}) {
  const captures = [];
  return createHarness(createFileChangeExtension({
    persistManifest: false,
    appendEntry: false,
    ...options,
    onCapture: (capture) => captures.push(capture)
  }), cwd, captures);
}

async function withTempDirectory(run) {
  const created = await mkdtemp(path.join(tmpdir(), "pi-file-changes-test-"));
  const directory = await realpath(created);
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
