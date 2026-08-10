import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
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

test("captures added, modified, deleted, shell-style changes, and spaced paths in stable order", async () => {
  await withTempDirectory(async (root) => {
    await writeFile(path.join(root, "deleted.txt"), "remove me\n");
    await writeFile(path.join(root, "edited.txt"), "before\n");
    const harness = createTrackingHarness(root, {
      persistManifest: false,
      appendEntry: false
    });

    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "with space.txt"), "created by a shell command\n");
    await writeFile(path.join(root, "edited.txt"), "after\n");
    await rm(path.join(root, "deleted.txt"));
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.equal(capture.schemaVersion, FILE_CHANGES_SCHEMA_VERSION);
    assert.deepEqual(capture.changes.map(({ path: filePath, status }) => [filePath, status]), [
      ["deleted.txt", "deleted"],
      ["edited.txt", "modified"],
      ["with space.txt", "added"]
    ]);
    assert.deepEqual(capture.counts, { added: 1, modified: 1, deleted: 1, total: 3 });
    const edited = capture.changes.find((change) => change.path === "edited.txt");
    assert.equal(edited.kind, "text");
    assert.equal(edited.text.before.text, "before\n");
    assert.equal(edited.text.after.text, "after\n");
    assert.match(edited.text.unifiedDiff.text, /-before/);
    assert.match(edited.text.unifiedDiff.text, /\+after/);
    assert.match(edited.before.sha256, /^[a-f0-9]{64}$/);
    assert.equal(edited.before.size, 7);
    assert.equal(capture.coverage.bashCoverage, "agent-start-roots-only");
    assert.equal(capture.coverage.roots[0].bashCovered, true);
  });
});

test("represents a rename as delete plus add without inference", async () => {
  await withTempDirectory(async (root) => {
    await writeFile(path.join(root, "old name.txt"), "same bytes\n");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await rename(path.join(root, "old name.txt"), path.join(root, "new name.txt"));
    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.deepEqual(harness.capture().changes.map(({ path: filePath, status }) => [filePath, status]), [
      ["new name.txt", "added"],
      ["old name.txt", "deleted"]
    ]);
  });
});

test("reports an executable-bit-only change with unchanged content hash", {
  skip: process.platform === "win32" ? "Windows does not expose POSIX executable mode changes" : false
}, async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "script.sh");
    await writeFile(target, "#!/bin/sh\nexit 0\n");
    await chmod(target, 0o644);
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await chmod(target, 0o755);
    await harness.emit("agent_settled", { type: "agent_settled" });

    const change = harness.capture().changes[0];
    assert.equal(change.status, "modified");
    assert.equal(change.before.sha256, change.after.sha256);
    assert.equal(change.before.mode, "100644");
    assert.equal(change.after.mode, "100755");
  });
});

test("keeps the first baseline across repeated agent_start events until settled", async () => {
  await withTempDirectory(async (root) => {
    await writeFile(path.join(root, "retry.txt"), "initial\n");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "retry.txt"), "after first loop\n");
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "retry.txt"), "after retry\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const change = harness.capture().changes[0];
    assert.equal(change.text.before.text, "initial\n");
    assert.equal(change.text.after.text, "after retry\n");
  });
});

test("captures image before and after payloads with media types", async () => {
  await withTempDirectory(async (root) => {
    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const before = Buffer.concat([pngHeader, Buffer.from("before")]);
    const after = Buffer.concat([pngHeader, Buffer.from("after")]);
    await writeFile(path.join(root, "preview.png"), before);
    await writeFile(path.join(root, "opaque.bin"), Buffer.from([0, 1, 2]));
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "preview.png"), after);
    await writeFile(path.join(root, "opaque.bin"), Buffer.from([0, 1, 3]));
    await harness.emit("agent_settled", { type: "agent_settled" });

    const change = harness.capture().changes.find((item) => item.path === "preview.png");
    assert.equal(change.kind, "image");
    assert.equal(change.image.before.mediaType, "image/png");
    assert.equal(change.image.before.base64, before.toString("base64"));
    assert.equal(change.image.after.base64, after.toString("base64"));
    assert.equal(change.text, undefined);
    const opaque = harness.capture().changes.find((item) => item.path === "opaque.bin");
    assert.equal(opaque.kind, "other");
    assert.equal(opaque.text, undefined);
    assert.equal(opaque.image, undefined);
  });
});

test("dynamically baselines a write target outside initial roots", async () => {
  await withTempDirectory(async (container) => {
    const root = path.join(container, "primary");
    const external = path.join(container, "external files");
    const externalEdit = path.join(container, "external edit");
    await mkdir(root);
    await mkdir(external);
    await mkdir(externalEdit);
    const target = path.join(external, "outside.txt");
    const sibling = path.join(external, "unrelated.txt");
    const editTarget = path.join(externalEdit, "existing.txt");
    await writeFile(editTarget, "before edit\n");
    await writeFile(sibling, "sibling before\n");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "write-outside",
      toolName: "write",
      input: { path: target, content: "outside\n" }
    });
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "edit-outside",
      toolName: "edit",
      input: {
        path: path.relative(root, editTarget),
        edits: [{ oldText: "before", newText: "after" }]
      }
    });
    await writeFile(target, "outside\n");
    await writeFile(sibling, "sibling changed but not targeted\n");
    await writeFile(editTarget, "after edit\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    const outside = capture.changes.find((change) => change.absolutePath === target);
    assert.equal(outside.status, "added");
    assert.equal(capture.changes.some((change) => change.absolutePath === sibling), false);
    const editedOutside = capture.changes.find((change) => change.absolutePath === editTarget);
    assert.equal(editedOutside.status, "modified");
    assert.equal(editedOutside.text.before.text, "before edit\n");
    assert.equal(editedOutside.text.after.text, "after edit\n");
    const externalCoverage = capture.coverage.roots.find((coverage) => coverage.path === external);
    assert.equal(externalCoverage.source, "write-target");
    assert.equal(externalCoverage.scope, "file");
    assert.equal(externalCoverage.filePath, target);
    assert.equal(externalCoverage.bashCovered, false);
    assert.equal(capture.coverage.roots.find((coverage) => coverage.path === externalEdit).source, "write-target");
  });
});

test("an explicit directory link keeps its logical root and scans its physical target", async (t) => {
  await withTempDirectory(async (container) => {
    const physicalRoot = path.join(container, "physical-root");
    const logicalRoot = path.join(container, "logical-root");
    await mkdir(physicalRoot);
    await writeFile(path.join(physicalRoot, "linked.txt"), "before\n");
    if (!await createDirectoryLink(physicalRoot, logicalRoot, t)) return;

    const harness = createTrackingHarness(container, { roots: [logicalRoot] });
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(physicalRoot, "linked.txt"), "after\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.equal(capture.changes.length, 1);
    assert.equal(capture.changes[0].path, "linked.txt");
    assert.equal(capture.changes[0].status, "modified");
    const rootCoverage = capture.coverage.roots.find((coverage) => samePath(coverage.path, logicalRoot));
    assert.ok(rootCoverage, "coverage must preserve the explicitly requested logical root");
    assert.equal(samePath(rootCoverage.physicalPath, await realpath(physicalRoot)), true);
    assert.notEqual(samePath(rootCoverage.path, rootCoverage.physicalPath), true);
  });
});

test("an exact edit under a configured directory link deduplicates by physical identity", async (t) => {
  await withTempDirectory(async (container) => {
    const physicalRoot = path.join(container, "physical-root");
    const logicalRoot = path.join(container, "logical-root");
    const physicalTarget = path.join(physicalRoot, "linked.txt");
    const logicalTarget = path.join(logicalRoot, "linked.txt");
    await mkdir(physicalRoot);
    await writeFile(physicalTarget, "run initial\n");
    if (!await createDirectoryLink(physicalRoot, logicalRoot, t)) return;

    const harness = createTrackingHarness(container, { roots: [logicalRoot] });
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "edit-under-configured-link",
      toolName: "edit",
      input: { path: logicalTarget, edits: [{ oldText: "run initial", newText: "final" }] }
    });
    await writeFile(physicalTarget, "final\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.equal(capture.changes.length, 1, "logical recursive and physical exact coverage must deduplicate");
    const change = capture.changes[0];
    assert.equal(change.status, "modified");
    assert.equal(change.text.before.text, "run initial\n");
    assert.equal(change.text.after.text, "final\n");
    assert.equal(samePath(change.absolutePath, logicalTarget), true, "the winning run-start root keeps its logical output path");
    assert.equal(samePath(change.absolutePath, physicalTarget), false);
    const recursiveRoot = capture.coverage.roots.find((coverage) => coverage.scope === "recursive");
    const exactRoot = capture.coverage.roots.find((coverage) => coverage.scope === "file");
    assert.ok(recursiveRoot);
    assert.ok(exactRoot);
    assert.equal(change.rootId, recursiveRoot.id, "the earliest run-start baseline must win overlap deduplication");
  });
});

test("a managed path through a tree link is canonicalized to an exact external file", async (t) => {
  await withTempDirectory(async (container) => {
    const root = path.join(container, "root");
    const outside = path.join(container, "outside");
    const link = path.join(root, "link");
    const externalTarget = path.join(outside, "target.txt");
    const requestedTarget = path.join(link, "target.txt");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(externalTarget, "before\n");
    if (!await createDirectoryLink(outside, link, t)) return;

    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "edit-through-directory-link",
      toolName: "edit",
      input: { path: requestedTarget, edits: [{ oldText: "before", newText: "after" }] }
    });
    await writeFile(externalTarget, "after\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.equal(capture.changes.length, 1, "tree traversal must not follow the directory link");
    assert.equal(samePath(capture.changes[0].absolutePath, await realpath(externalTarget)), true);
    assert.equal(capture.changes[0].status, "modified");
    const exactRoot = capture.coverage.roots.find((coverage) => coverage.scope === "file"
      && samePath(coverage.filePath, externalTarget));
    assert.ok(exactRoot, "the tool hook must register the canonical external target");
    assert.equal(samePath(exactRoot.requestedPath ?? exactRoot.requestedFilePath, requestedTarget), true);
    assert.equal(exactRoot.source, "write-target");
    assert.equal(exactRoot.bashCovered, false);
  });
});

test("marks bash runs partial even when the covered root has no net change", async () => {
  await withTempDirectory(async (root) => {
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "bash-no-change",
      toolName: "bash",
      input: { command: "echo observed only inside roots" }
    });
    await harness.emit("agent_settled", { type: "agent_settled" });
    const capture = harness.capture();
    assert.deepEqual(capture.changes, []);
    assert.equal(capture.coverage.bashInvoked, true);
    assert.equal(capture.coverage.status, "partial");
    assert.match(capture.coverage.reason, /outside those roots are unobservable/);
  });
});

test("a later exact edit preserves the agent-start baseline after bash changed an existing file", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "existing.txt");
    await writeFile(target, "initial\n");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "bash-existing",
      toolName: "bash",
      input: { command: "modify existing.txt" }
    });
    await writeFile(target, "after bash\n");
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "edit-existing",
      toolName: "edit",
      input: { path: target, edits: [{ oldText: "after bash", newText: "final" }] }
    });
    await writeFile(target, "final\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const change = harness.capture().changes[0];
    assert.equal(change.status, "modified");
    assert.equal(change.text.before.text, "initial\n");
    assert.equal(change.text.after.text, "final\n");
  });
});

test("a bash-created file remains added when a later exact edit sees it", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "created.txt");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "bash-create",
      toolName: "bash",
      input: { command: "create created.txt" }
    });
    await writeFile(target, "created by bash\n");
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "edit-created",
      toolName: "edit",
      input: { path: target, edits: [{ oldText: "created by bash", newText: "final" }] }
    });
    await writeFile(target, "final\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const change = harness.capture().changes[0];
    assert.equal(change.status, "added");
    assert.equal(change.before, null);
    assert.equal(change.text.before, null);
    assert.equal(change.text.after.text, "final\n");
  });
});

test("reports deterministic file and byte traversal limits as partial", async () => {
  await withTempDirectory(async (root) => {
    await writeFile(path.join(root, "a.txt"), "aaaa");
    await writeFile(path.join(root, "b.txt"), "bbbb");
    const fileLimited = createTrackingHarness(root, { maxFiles: 1 });
    await fileLimited.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "a.txt"), "AAaa");
    await fileLimited.emit("agent_settled", { type: "agent_settled" });
    assert.deepEqual(fileLimited.capture().changes.map((change) => change.path), ["a.txt"]);
    assert.equal(fileLimited.capture().coverage.status, "partial");
    assert.equal(fileLimited.capture().coverage.issues.some((issue) => issue.code === "max-files"), true);

    const byteLimited = createTrackingHarness(root, { maxTotalBytes: 5 });
    await byteLimited.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "a.txt"), "AaAa");
    await byteLimited.emit("agent_settled", { type: "agent_settled" });
    assert.deepEqual(byteLimited.capture().changes.map((change) => change.path), ["a.txt"]);
    assert.equal(byteLimited.capture().coverage.issues.some((issue) => issue.code === "max-total-bytes"), true);
  });
});

test("an exact edit target wins when a recursive root limit omitted that file", async () => {
  await withTempDirectory(async (root) => {
    const first = path.join(root, "a.txt");
    const target = path.join(root, "z.txt");
    await writeFile(first, "first\n");
    await writeFile(target, "before\n");
    const harness = createTrackingHarness(root, { maxFiles: 1 });

    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "edit-file-omitted-by-root-limit",
      toolName: "edit",
      input: { path: target, edits: [{ oldText: "before", newText: "after" }] }
    });
    await writeFile(target, "after\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.deepEqual(capture.changes.map(({ absolutePath, status }) => [absolutePath, status]), [
      [target, "modified"]
    ]);
    const exactRoot = capture.coverage.roots.find((rootCoverage) => rootCoverage.scope === "file"
      && samePath(rootCoverage.filePath, target));
    assert.ok(exactRoot, "the managed edit target must have its own exact-file baseline");
    assert.equal(capture.changes[0].rootId, exactRoot.id, "exact-file coverage must win overlap deduplication");
    assert.equal(capture.changes[0].text.before.text, "before\n");
    assert.equal(capture.changes[0].text.after.text, "after\n");
    assert.equal(capture.coverage.status, "partial");
    assert.equal(capture.coverage.issues.some((issue) => issue.code === "max-files"), true);
  });
});

test("an incomplete baseline read cannot create a false added change", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "unstable.txt");
    await writeFile(target, "baseline bytes\n");
    let removeDuringFirstSnapshot = true;
    const harness = createTrackingHarness(root, {
      shouldRedact: async ({ absolutePath }) => {
        if (removeDuringFirstSnapshot && samePath(absolutePath, target)) {
          removeDuringFirstSnapshot = false;
          await rm(absolutePath);
        }
        return false;
      }
    });

    await harness.emit("agent_start", { type: "agent_start" });
    assert.equal(removeDuringFirstSnapshot, false, "the baseline read-failure trigger did not run");
    await writeFile(target, "final bytes\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.deepEqual(capture.changes, [], "unknown baseline state must suppress a possible false addition");
    assert.equal(capture.coverage.status, "partial");
    assert.equal(capture.coverage.partial, true);
    assert.equal(capture.coverage.issues.some((issue) => issue.code === "read-error"
      && issue.stage === "baseline"
      && samePath(issue.path, target)), true);
  });
});

test("a file that grows after stat cannot bypass the streamed root byte cap", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "growing.txt");
    await writeFile(target, "a");
    let expanded = false;
    const harness = createTrackingHarness(root, {
      maxTotalBytes: 4,
      shouldRedact: async ({ absolutePath }) => {
        if (!expanded && samePath(absolutePath, target)) {
          expanded = true;
          await appendFile(target, "0123456789");
        }
        return false;
      }
    });
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(target, "b");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.deepEqual(capture.changes, []);
    assert.equal(capture.coverage.status, "partial");
    assert.equal(capture.coverage.issues.some((issue) => issue.code === "max-total-bytes"
      && issue.stage === "baseline"), true);
  });
});

test("coverage diagnostics are bounded and disclose omitted counts", async () => {
  await withTempDirectory(async (root) => {
    for (let index = 0; index < 120; index += 1) {
      await writeFile(path.join(root, `unstable-${String(index).padStart(3, "0")}.txt`), "baseline\n");
    }
    const harness = createTrackingHarness(root, {
      maxFiles: 200,
      shouldRedact: async ({ absolutePath }) => {
        await rm(absolutePath);
        return false;
      }
    });
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("agent_settled", { type: "agent_settled" });

    const coverage = harness.capture().coverage;
    assert.equal(coverage.status, "partial");
    assert.equal(coverage.warnings.length, 100);
    assert.equal(coverage.omittedWarningCount, 20);
    assert.equal(coverage.issues.length, 100);
    assert.equal(coverage.omittedIssueCount, 20);
  });
});

test("large image and total content limits retain metadata without payloads", async () => {
  await withTempDirectory(async (root) => {
    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(path.join(root, "large.png"), Buffer.concat([pngHeader, Buffer.alloc(64, 1)]));
    const perFile = createTrackingHarness(root, { maxContentBytes: 16 });
    await perFile.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "large.png"), Buffer.concat([pngHeader, Buffer.alloc(64, 2)]));
    await perFile.emit("agent_settled", { type: "agent_settled" });
    const imageChange = perFile.capture().changes[0];
    assert.equal(imageChange.kind, "image");
    assert.equal(imageChange.contentOmitted, true);
    assert.equal(imageChange.image, undefined);
    assert.match(imageChange.before.sha256, /^[a-f0-9]{64}$/);
    assert.equal(imageChange.before.size, 72);
    assert.equal(imageChange.contentOmittedReason, "max-content-bytes");
    assert.equal(perFile.capture().coverage.status, "complete");

    await writeFile(path.join(root, "a.txt"), "123456");
    await writeFile(path.join(root, "b.txt"), "abcdef");
    const total = createTrackingHarness(root, {
      maxContentBytes: 100,
      maxCapturedContentBytes: 10
    });
    await total.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "b.txt"), "ABCDEF");
    await total.emit("agent_settled", { type: "agent_settled" });
    const totalChange = total.capture().changes.find((change) => change.path === "b.txt");
    assert.equal(totalChange.contentOmitted, true);
    assert.equal(totalChange.text, undefined);
    assert.equal(totalChange.contentOmittedReason, "max-captured-content-bytes");
    assert.equal(total.capture().coverage.status, "complete");
  });
});

test("maxRoots is a hard deterministic cap", async () => {
  await withTempDirectory(async (container) => {
    const firstRoot = path.join(container, "a-root");
    const secondRoot = path.join(container, "z-root");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await writeFile(path.join(firstRoot, "first.txt"), "before\n");
    await writeFile(path.join(secondRoot, "second.txt"), "before\n");
    const harness = createTrackingHarness(container, {
      roots: [secondRoot, firstRoot],
      maxRoots: 1
    });

    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(firstRoot, "first.txt"), "after\n");
    await writeFile(path.join(secondRoot, "second.txt"), "after\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.equal(capture.coverage.roots.length, 1);
    assert.equal(samePath(capture.coverage.roots[0].path, firstRoot), true);
    assert.deepEqual(capture.changes.map((change) => change.path), ["first.txt"]);
    assert.equal(capture.coverage.status, "partial");
    assert.equal(capture.coverage.limits.maxRoots, 1);
    assert.equal(capture.coverage.issues.some((issue) => issue.code === "max-roots"), true);
  });
});

test("maxManagedTargets rejects later exact targets without widening coverage", async () => {
  await withTempDirectory(async (container) => {
    const root = path.join(container, "root");
    const external = path.join(container, "external");
    const firstTarget = path.join(external, "a.txt");
    const secondTarget = path.join(external, "z.txt");
    await mkdir(root);
    await mkdir(external);
    await writeFile(firstTarget, "before-a\n");
    await writeFile(secondTarget, "before-z\n");
    const harness = createTrackingHarness(root, { maxManagedTargets: 1 });

    await harness.emit("agent_start", { type: "agent_start" });
    for (const [toolCallId, target] of [["first-target", firstTarget], ["second-target", secondTarget]]) {
      await harness.emit("tool_call", {
        type: "tool_call",
        toolCallId,
        toolName: "edit",
        input: { path: target, edits: [] }
      });
    }
    await writeFile(firstTarget, "after-a\n");
    await writeFile(secondTarget, "after-z\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.deepEqual(capture.changes.map((change) => change.absolutePath), [firstTarget]);
    assert.equal(capture.coverage.roots.filter((coverage) => coverage.scope === "file").length, 1);
    assert.equal(capture.coverage.limits.maxManagedTargets, 1);
    assert.equal(capture.coverage.issues.some((issue) => issue.code === "max-managed-targets"), true);
    assert.equal(capture.coverage.status, "partial");
  });
});

test("maxChanges returns a bounded deterministic prefix", async () => {
  await withTempDirectory(async (root) => {
    await writeFile(path.join(root, "a.txt"), "before-a\n");
    await writeFile(path.join(root, "z.txt"), "before-z\n");
    const harness = createTrackingHarness(root, { maxChanges: 1 });
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "a.txt"), "after-a\n");
    await writeFile(path.join(root, "z.txt"), "after-z\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.deepEqual(capture.changes.map((change) => change.path), ["a.txt"]);
    assert.deepEqual(capture.counts, { added: 0, modified: 1, deleted: 0, total: 1 });
    assert.equal(capture.coverage.limits.maxChanges, 1);
    assert.equal(capture.coverage.issues.some((issue) => issue.code === "max-changes"), true);
    assert.equal(capture.coverage.status, "partial");
  });
});

test("maxRunCapturedContentBytes omits payloads without losing change metadata", async () => {
  await withTempDirectory(async (root) => {
    const target = path.join(root, "budget.txt");
    await writeFile(target, "123456");
    const harness = createTrackingHarness(root, {
      maxContentBytes: 100,
      maxCapturedContentBytes: 100,
      maxRunCapturedContentBytes: 10
    });
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(target, "ABCDEF");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.equal(capture.changes.length, 1);
    assert.equal(capture.changes[0].status, "modified");
    assert.equal(capture.changes[0].contentOmitted, true);
    assert.equal(capture.changes[0].text, undefined);
    assert.match(capture.changes[0].before.sha256, /^[a-f0-9]{64}$/);
    assert.match(capture.changes[0].after.sha256, /^[a-f0-9]{64}$/);
    assert.equal(capture.coverage.limits.maxRunCapturedContentBytes, 10);
    assert.equal(capture.changes[0].contentOmittedReason, "max-run-captured-content-bytes");
    assert.equal(capture.coverage.status, "complete");
  });
});

test("a configured root created after baseline reports its files as added", async () => {
  await withTempDirectory(async (container) => {
    const root = path.join(container, "created-during-run");
    const harness = createTrackingHarness(container, { roots: [root] });
    await harness.emit("agent_start", { type: "agent_start" });
    await mkdir(root);
    await writeFile(path.join(root, "new.txt"), "new root contents\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.deepEqual(capture.changes.map(({ path: filePath, status }) => [filePath, status]), [
      ["new.txt", "added"]
    ]);
    assert.equal(capture.coverage.roots.length, 1);
    assert.equal(samePath(capture.coverage.roots[0].path, root), true);
  });
});

test("deleting an existing configured root reports its files as deleted", async () => {
  await withTempDirectory(async (container) => {
    const root = path.join(container, "deleted-during-run");
    await mkdir(root);
    await writeFile(path.join(root, "gone.txt"), "gone root contents\n");
    const harness = createTrackingHarness(container, { roots: [root] });
    await harness.emit("agent_start", { type: "agent_start" });
    await rm(root, { recursive: true });
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.deepEqual(capture.changes.map(({ path: filePath, status }) => [filePath, status]), [
      ["gone.txt", "deleted"]
    ]);
  });
});

test("one thousand small files complete within a broad regression budget", { timeout: 45_000 }, async () => {
  await withTempDirectory(async (root) => {
    const writes = [];
    for (let index = 0; index < 1_000; index += 1) {
      writes.push(writeFile(path.join(root, `file-${String(index).padStart(4, "0")}.txt`), `value-${index}\n`));
    }
    await Promise.all(writes);
    const harness = createTrackingHarness(root, {
      maxFiles: 1_100,
      maxTotalBytes: 10 * 1024 * 1024
    });

    const startedAt = Date.now();
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "file-0999.txt"), "changed\n");
    await harness.emit("agent_settled", { type: "agent_settled" });
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 30_000, `1k-file capture took ${elapsedMs}ms`);
    assert.deepEqual(harness.capture().changes.map((change) => change.path), ["file-0999.txt"]);
    assert.equal(harness.capture().coverage.status, "complete");
  });
});

test("one hundred changed text files use batched root diffing", { timeout: 30_000 }, async () => {
  await withTempDirectory(async (root) => {
    for (let index = 0; index < 100; index += 1) {
      await writeFile(path.join(root, `changed-${String(index).padStart(3, "0")}.txt`), `before-${index}\n`);
    }
    const harness = createTrackingHarness(root);
    const startedAt = Date.now();
    await harness.emit("agent_start", { type: "agent_start" });
    for (let index = 0; index < 100; index += 1) {
      await writeFile(path.join(root, `changed-${String(index).padStart(3, "0")}.txt`), `after-${index}\n`);
    }
    await harness.emit("agent_settled", { type: "agent_settled" });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(harness.capture().changes.length, 100);
    assert.ok(elapsedMs < 10_000, `100 changed files took ${elapsedMs}ms; root diffing is not batched`);
    assert.equal(harness.capture().changes.every((change) => change.text.unifiedDiff.text.includes("after-")), true);
  });
});

test("one hundred in-root write hooks reuse complete recursive final evidence", { timeout: 30_000 }, async () => {
  await withTempDirectory(async (root) => {
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    const startedAt = Date.now();
    for (let index = 0; index < 100; index += 1) {
      const target = path.join(root, `hooked-${String(index).padStart(3, "0")}.txt`);
      await harness.emit("tool_call", {
        type: "tool_call",
        toolCallId: `write-${index}`,
        toolName: "write",
        input: { path: target, content: `created-${index}\n` }
      });
      await writeFile(target, `created-${index}\n`);
    }
    await harness.emit("agent_settled", { type: "agent_settled" });
    const elapsedMs = Date.now() - startedAt;

    const capture = harness.capture();
    assert.equal(capture.changes.length, 100);
    assert.ok(elapsedMs < 10_000, `100 in-root write hooks took ${elapsedMs}ms; exact finals were not skipped`);
    const recursiveRoot = capture.coverage.roots.find((coverage) => coverage.scope === "recursive");
    assert.ok(recursiveRoot);
    assert.equal(capture.coverage.roots.filter((coverage) => coverage.scope === "file").length, 100);
    assert.equal(capture.changes.every((change) => change.rootId === recursiveRoot.id && change.status === "added"), true);
  });
});

test("empty runs stay empty and excluded directories never appear", async () => {
  await withTempDirectory(async (root) => {
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, ".pi", "file-changes"), { recursive: true });
    await writeFile(path.join(root, ".git", "config"), "secret-ish git metadata\n");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "old\n");
    await writeFile(path.join(root, ".pi", "file-changes", "old.json"), "{}\n");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, ".git", "config"), "changed\n");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "changed\n");
    await writeFile(path.join(root, ".pi", "file-changes", "new.json"), "{}\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.deepEqual(capture.changes, []);
    assert.deepEqual(capture.counts, { added: 0, modified: 0, deleted: 0, total: 0 });
    assert.deepEqual(capture.coverage.excludes, [
      "**/.git/**",
      "**/node_modules/**",
      "**/.pi/file-changes/**"
    ]);
  });
});

test("text limits truncate on UTF-8 boundaries", async () => {
  await withTempDirectory(async (root) => {
    await writeFile(path.join(root, "large.txt"), "old\n");
    const harness = createTrackingHarness(root, {
      persistManifest: false,
      appendEntry: false,
      maxTextBytes: 5,
      maxDiffBytes: 24
    });
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "large.txt"), "你好世界\n");
    await harness.emit("agent_settled", { type: "agent_settled" });
    const text = harness.capture().changes[0].text;
    assert.equal(text.after.truncated, true);
    assert.equal(text.after.text, "你");
    assert.equal(text.after.byteSize, Buffer.byteLength("你好世界\n"));
    assert.equal(text.unifiedDiff.truncated, true);
    assert.ok(Buffer.byteLength(text.unifiedDiff.text) <= 24);
  });
});

test("built-in and injected secret predicates redact content and diff", async () => {
  await withTempDirectory(async (root) => {
    await withTempDirectory(async (snapshotParent) => {
      const builtInSecrets = [
        [".env.production", "env-secret"],
        [".npmrc", "npm-secret"],
        [".pypirc", "pypi-secret"],
        [".netrc", "netrc-secret"],
        ["auth.json", "auth-secret"],
        ["id_ed25519_work", "ssh-secret"],
        ["signing.p12", "p12-secret"],
        ["token.json", "token-secret"],
        ["access.token", "suffix-token-secret"],
        ["credentials.production.json", "credentials-secret"],
        ["secrets.yaml", "secrets-secret"]
      ];
      for (const [fileName, marker] of builtInSecrets) {
        await writeFile(path.join(root, fileName), `before-${marker}\n`);
      }
      await writeFile(path.join(root, "customer.private"), "before-customer-secret\n");
      const harness = createTrackingHarness(root, {
        persistManifest: false,
        appendEntry: false,
        temporaryDirectory: snapshotParent,
        shouldRedact: ({ path: filePath }) => filePath.endsWith(".private")
      });
      await harness.emit("agent_start", { type: "agent_start" });

      const [runDirectory] = await readdir(snapshotParent);
      const gitDirectory = path.join(snapshotParent, runDirectory, "repo.git");
      const objectLines = execFileSync("git", [
        "--git-dir",
        gitDirectory,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)"
      ], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/).filter(Boolean);
      for (const line of objectLines) {
        const [oid, type] = line.split(" ");
        if (type !== "blob") continue;
        const blob = execFileSync("git", ["--git-dir", gitDirectory, "cat-file", "blob", oid], { windowsHide: true });
        for (const [, marker] of builtInSecrets) {
          assert.equal(blob.includes(Buffer.from(`before-${marker}`)), false, `${marker} leaked into the Git object store`);
        }
        assert.equal(blob.includes(Buffer.from("before-customer-secret")), false);
      }

      for (const [fileName, marker] of builtInSecrets) {
        await writeFile(path.join(root, fileName), `after-${marker}\n`);
      }
      await writeFile(path.join(root, "customer.private"), "after-customer-secret\n");
      await harness.emit("agent_settled", { type: "agent_settled" });

      assert.equal(harness.capture().changes.length, builtInSecrets.length + 1);
      for (const change of harness.capture().changes) {
        assert.equal(change.redacted, true);
        assert.equal(change.text, undefined);
        assert.equal(change.image, undefined);
        assert.match(change.before.sha256, /^[a-f0-9]{64}$/);
        assert.match(change.after.sha256, /^[a-f0-9]{64}$/);
      }
      const serialized = JSON.stringify(harness.capture());
      for (const [, marker] of builtInSecrets) {
        assert.equal(serialized.includes(`before-${marker}`), false);
        assert.equal(serialized.includes(`after-${marker}`), false);
      }
      assert.equal(serialized.includes("customer-secret"), false);
    });
  });
});

test("high-confidence content secrets and injected content predicates redact both versions", async () => {
  await withTempDirectory(async (root) => {
    await withTempDirectory(async (snapshotParent) => {
      await mkdir(path.join(root, "src"));
      const fixtures = [
        ["config.yml", "api_key: baseline-super-secret-value\n", "api_key: final-super-secret-value\n"],
        ["settings.json", '{"password":"baseline-password-value"}\n', '{"password":"final-password-value"}\n'],
        [path.join("src", "config.ts"), 'export const service = "sk-1234567890abcdefghijklmnop";\n', 'export const service = "sk-abcdefghijklmnop1234567890";\n'],
        ["headers.txt", "Authorization: Bearer abcdefghijklmnop1234\n", "Authorization: Bearer zyxwvutsrqponmlk9876\n"],
        ["later-secret.txt", "ordinary baseline words\n", "client_secret: final-secret-value\n"],
        ["customer.cfg", "private customer baseline\n", "private customer final\n"],
        ["predicate-error.cfg", "ordinary error baseline\n", "ordinary error final\n"]
      ];
      for (const [relativePath, before] of fixtures) {
        await writeFile(path.join(root, relativePath), before);
      }
      const captures = [];
      const harness = createHarness(createFileChangeExtension({
        persistManifest: false,
        appendEntry: true,
        temporaryDirectory: snapshotParent,
        shouldRedactContent: ({ path: relativePath, content }) => {
          if (relativePath === "predicate-error.cfg") throw new Error("predicate unavailable");
          return relativePath === "customer.cfg" && content.includes(Buffer.from("private customer"));
        },
        onCapture: (capture) => captures.push(capture)
      }), root, captures);
      await harness.emit("agent_start", { type: "agent_start" });

      const [runDirectory] = await readdir(snapshotParent);
      const gitDirectory = path.join(snapshotParent, runDirectory, "repo.git");
      const objectListing = execFileSync("git", [
        "--git-dir",
        gitDirectory,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)"
      ], { encoding: "utf8", windowsHide: true });
      for (const line of objectListing.trim().split(/\r?\n/).filter(Boolean)) {
        const [oid, type] = line.split(" ");
        if (type !== "blob") continue;
        const blob = execFileSync("git", ["--git-dir", gitDirectory, "cat-file", "blob", oid], { windowsHide: true });
        for (const [_relativePath, before] of fixtures) {
          assert.equal(blob.includes(Buffer.from(before.trim())), false, "secret content leaked into the temporary Git store");
        }
      }

      for (const [relativePath, _before, after] of fixtures) {
        await writeFile(path.join(root, relativePath), after);
      }
      await harness.emit("agent_settled", { type: "agent_settled" });

      const capture = harness.capture();
      assert.equal(capture.changes.length, fixtures.length);
      for (const change of capture.changes) {
        assert.equal(change.redacted, true, `${change.path} should be redacted`);
        assert.equal(change.text, undefined);
        assert.equal(change.image, undefined);
      }
      assert.equal(capture.coverage.status, "partial");
      assert.equal(capture.coverage.warnings.some((warning) => /failed closed/.test(warning)), true);
      const serializedCapture = JSON.stringify(capture);
      const serializedEntry = JSON.stringify(harness.entries[0]);
      for (const [_relativePath, before, after] of fixtures) {
        assert.equal(serializedCapture.includes(before.trim()), false);
        assert.equal(serializedCapture.includes(after.trim()), false);
        assert.equal(serializedEntry.includes(before.trim()), false);
        assert.equal(serializedEntry.includes(after.trim()), false);
      }
    });
  });
});

test("token-like source filenames are not redacted without a secret boundary or content match", async () => {
  await withTempDirectory(async (root) => {
    const names = ["tokens.ts", "tokenizer.ts", "tokenStyles.css", "credentialsHelper.ts", "secretsManager.ts"];
    for (const name of names) await writeFile(path.join(root, name), "ordinary before\n");
    const harness = createTrackingHarness(root);
    await harness.emit("agent_start", { type: "agent_start" });
    for (const name of names) await writeFile(path.join(root, name), "ordinary after\n");
    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.deepEqual(harness.capture().changes.map((change) => change.path), [...names].sort());
    for (const change of harness.capture().changes) {
      assert.equal(change.redacted, false, `${change.path} must not be a filename false positive`);
      assert.equal(change.text.after.text, "ordinary after\n");
    }
  });
});

test("ambient Git repository-scoping environment variables cannot redirect snapshots", async () => {
  await withTempDirectory(async (root) => {
    await withTempDirectory(async (bogus) => {
      const keys = [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_WORK_TREE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_GLOBAL"
      ];
      const previous = new Map(keys.map((key) => [key, process.env[key]]));
      for (const key of keys) process.env[key] = path.join(bogus, `${key}.invalid`);
      try {
        const harness = createTrackingHarness(root);
        await harness.emit("agent_start", { type: "agent_start" });
        await writeFile(path.join(root, "isolated.txt"), "isolated\n");
        await harness.emit("agent_settled", { type: "agent_settled" });
        assert.deepEqual(harness.capture().changes.map(({ path: filePath, status }) => [filePath, status]), [
          ["isolated.txt", "added"]
        ]);
        assert.equal(harness.capture().coverage.status, "complete");
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});

test("Git snapshot initialization failure produces an explicit failed capture", async () => {
  await withTempDirectory(async (root) => {
    const notADirectory = path.join(root, "temporary-parent-is-a-file");
    await writeFile(notADirectory, "block mkdir\n");
    const harness = createTrackingHarness(root, { temporaryDirectory: notADirectory });
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "unobservable.txt"), "not guessed\n");
    await harness.emit("agent_settled", { type: "agent_settled" });

    const capture = harness.capture();
    assert.equal(capture.coverage.status, "failed");
    assert.equal(capture.coverage.partial, true);
    assert.match(capture.coverage.reason, /initialize external Git snapshot repository/i);
    assert.deepEqual(capture.changes, []);
    assert.deepEqual(capture.counts, { added: 0, modified: 0, deleted: 0, total: 0 });
  });
});

test("default CLI extension appends metadata only and requires explicit external manifest opt-in", async () => {
  await withTempDirectory(async (root) => {
    const harness = createHarness(defaultExtension, root);
    await harness.emit("agent_start", { type: "agent_start" });
    await writeFile(path.join(root, "visible.txt"), "raw source must stay out of the entry\n");
    await writeFile(path.join(root, "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
    await harness.emit("agent_settled", { type: "agent_settled" });

    assert.equal(harness.entries.length, 1);
    assert.equal(harness.entries[0].customType, FILE_CHANGES_ENTRY_TYPE);
    const entry = harness.entries[0].data;
    assert.equal(entry.schemaVersion, 1);
    assert.equal(entry.changes.length, 2);
    const serializedEntry = JSON.stringify(entry);
    assert.equal(serializedEntry.includes("raw source must stay out"), false);
    assert.equal(serializedEntry.includes("base64"), false);
    assert.equal(serializedEntry.includes("unifiedDiff"), false);
    assert.equal(serializedEntry.includes('"text":'), false);
    assert.equal(entry.manifestPath, null);
    await assert.rejects(access(path.join(root, ".pi", "file-changes")), { code: "ENOENT" });

    await withTempDirectory(async (manifestDirectory) => {
      const previous = process.env.PI_FILE_CHANGES_MANIFEST_DIR;
      process.env.PI_FILE_CHANGES_MANIFEST_DIR = manifestDirectory;
      try {
        const optedIn = createHarness(defaultExtension, root);
        await optedIn.emit("agent_start", { type: "agent_start" });
        await writeFile(path.join(root, "visible.txt"), "explicit external manifest\n");
        await optedIn.emit("agent_settled", { type: "agent_settled" });
        const optedInEntry = optedIn.entries[0].data;
        await access(optedInEntry.manifestPath);
        assert.equal(samePath(path.dirname(optedInEntry.manifestPath), manifestDirectory), true);
        const manifest = JSON.parse(await readFile(optedInEntry.manifestPath, "utf8"));
        assert.equal(manifest.changes[0].text.after.text, "explicit external manifest\n");
      } finally {
        if (previous === undefined) delete process.env.PI_FILE_CHANGES_MANIFEST_DIR;
        else process.env.PI_FILE_CHANGES_MANIFEST_DIR = previous;
      }
    });
  });
});

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
  const ctx = {
    cwd,
    mode: "json",
    hasUI: false
  };
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

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalizedLeft = path.resolve(left).replaceAll("\\", "/");
  const normalizedRight = path.resolve(right).replaceAll("\\", "/");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function createDirectoryLink(target, link, t) {
  try {
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error?.code)) {
      t.skip(`directory links are unavailable in this environment: ${error.code}`);
      return false;
    }
    throw error;
  }
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-file-changes-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
