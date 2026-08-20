// The path and URL reasoning behind local files an assistant answer references.
// These run against built output rather than Electron: the point is the
// decisions -- which request URLs resolve, which link targets are handed to the
// OS, what the renderer is told about a path -- not the wiring around them.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  describeLocalFiles,
  expandLocalPath,
  imageMediaType,
  isForwardableExternalUrl,
  localPathFromRequestUrl
} = await import("../../dist/main/main/services/localFilePaths.js");

// --- Request URL resolution -------------------------------------------------

// The renderer builds these by percent-encoding each path segment, so spaces
// and other literal characters must survive the round trip intact.
assert.equal(
  localPathFromRequestUrl("jasmine-file://local/Users/me/My%20Shots/a%20b.png"),
  path.resolve("/Users/me/My Shots/a b.png")
);
assert.equal(
  localPathFromRequestUrl("jasmine-file://local/tmp/100%25.png"),
  path.resolve("/tmp/100%.png")
);

// A Windows request carries a leading slash before the drive letter.
assert.equal(localPathFromRequestUrl("jasmine-file://local/C%3A/work/a.png"), path.resolve("C:/work/a.png"));

// Anything that is not this scheme and host is not ours to serve.
for (const url of [
  "file:///etc/passwd",
  "https://example.com/a.png",
  "jasmine-file://other/etc/passwd",
  "not a url"
]) {
  assert.equal(localPathFromRequestUrl(url), null, `should refuse ${url}`);
}

// Traversal cannot climb out, because the result is always a resolved absolute
// path and the handler only ever serves image types from it.
assert.equal(
  localPathFromRequestUrl("jasmine-file://local/Users/me/../../etc/passwd"),
  path.resolve("/etc/passwd")
);
assert.equal(localPathFromRequestUrl("jasmine-file://local/a%00b.png"), null);

// --- What may be displayed inline ------------------------------------------

assert.equal(imageMediaType("/a/b.PNG"), "image/png");
assert.equal(imageMediaType("/a/b.jpeg"), "image/jpeg");
assert.equal(imageMediaType("/a/b.svg"), "image/svg+xml");
assert.equal(imageMediaType("/a/b.docx"), undefined);
assert.equal(imageMediaType("/a/b"), undefined);

// --- Outward links ----------------------------------------------------------

for (const url of ["https://example.com", "http://example.com/a?b=1", "mailto:a@example.com"]) {
  assert.equal(isForwardableExternalUrl(url), true, `should forward ${url}`);
}
// A single click must never reach a scheme that can act with the user's
// authority, whichever way a model writes it.
for (const url of [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "file:///etc/passwd",
  "data:text/html,<script>x</script>",
  "vscode://file/a.ts",
  "smb://server/share",
  "",
  "/Users/me/a.txt",
  `https://example.com/${"a".repeat(9000)}`
]) {
  assert.equal(isForwardableExternalUrl(url), false, `should refuse ${url}`);
}

// --- Describing paths for the renderer --------------------------------------

const root = await mkdtemp(path.join(os.tmpdir(), "jasmine-local-files-"));
const imagePath = path.join(root, "chart.png");
const docPath = path.join(root, "report.docx");
const dirPath = path.join(root, "nested");
await writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));
await writeFile(docPath, "not really a document");
await mkdir(dirPath);

const described = await describeLocalFiles([imagePath, docPath, dirPath, path.join(root, "absent.txt")]);
const byPath = new Map(described.map((entry) => [entry.requestedPath, entry]));

const image = byPath.get(imagePath);
assert.equal(image.exists, true);
assert.equal(image.kind, "file");
assert.equal(image.isImage, true);
assert.equal(image.mediaType, "image/png");
assert.equal(image.name, "chart.png");

const doc = byPath.get(docPath);
assert.equal(doc.exists, true);
assert.equal(doc.isImage, false, "a non-image file must not be offered for inline display");
assert.equal(doc.mediaType, undefined);

assert.equal(byPath.get(dirPath).kind, "directory");

// A model naming a file that is not there is ordinary, not an error.
const absent = byPath.get(path.join(root, "absent.txt"));
assert.equal(absent.exists, false);
assert.equal(absent.kind, "missing");

// The requested spelling is echoed back so the renderer can match its own
// reference, while `path` carries the resolved form every action uses.
const homeReference = await describeLocalFiles(["~/definitely-not-here-9f2a"]);
assert.equal(homeReference[0].requestedPath, "~/definitely-not-here-9f2a");
assert.equal(homeReference[0].path, path.join(os.homedir(), "definitely-not-here-9f2a"));
assert.equal(expandLocalPath("~"), path.resolve(os.homedir()));

// Repeated references in one message cost one stat, not one per mention.
const deduped = await describeLocalFiles([imagePath, imagePath, ` ${imagePath} `.trim(), ""]);
assert.equal(deduped.length, 1);

console.log("local-files checks passed");
