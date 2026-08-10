# `@jasmine-ai/pi-file-changes`

A Pi extension package that emits changed-file evidence without requiring a Git
repository in the working directory. It deliberately does **not** take full
directory checkpoints: chat startup and settlement never crawl or hash the
workspace.

## Tracking modes

### `managed-tools-only` (default)

The extension hooks approved Pi `write` and `edit` calls. Immediately before
the first call for a path it captures that exact file, then captures the same
path after the run settles. This gives deterministic net added/modified state,
before/after text or image previews, and a Git-style text diff for normal-sized
files.

- Only exact managed targets are read. Siblings and unrelated archives are not
  opened or hashed.
- Failed tool calls are ignored.
- Repeated edits keep the first baseline; a final byte-for-byte revert produces
  no change.
- Bash and external-process changes are intentionally not tracked. Coverage
  records `bashCoverage: "not-tracked"` without calling the configured mode
  partial.
- There is no managed delete tool in Pi today, so shell-only deletions require
  watcher mode.

### `watcher` (experimental)

Watcher mode keeps the managed-tool behavior and adds native filesystem events
from `@parcel/watcher`. It subscribes to one explicit root but performs no
initial crawl. At settlement it reads only paths that emitted events.

This is fast and useful for Bash, but event evidence is intentionally weaker:

- updates may contain only the after revision;
- native backends may coalesce create and update events, so watcher-only
  added/modified status is approximate without an initial crawl;
- deleted paths may contain status/path only;
- rename is represented as delete plus add when the backend reports it that
  way;
- short-lived create-then-delete operations may be coalesced away;
- an event proves the path changed during the run, not which tool or process
  caused it.

The capture records `trackingMode: "watcher"` and
`bashCoverage: "watcher-observed"` so hosts can explain this boundary.

## Install with Pi CLI

Install a release archive or unpacked package by absolute path:

```powershell
pi install C:/absolute/path/to/pi-file-changes
```

For a one-off run:

```powershell
pi -e C:/absolute/path/to/pi-file-changes/dist/index.js
```

Once published to npm, the equivalent forms are:

```powershell
pi install npm:@jasmine-ai/pi-file-changes
pi -e npm:@jasmine-ai/pi-file-changes
```

The default CLI entrypoint uses `managed-tools-only`. Opt into watcher mode for
one process with:

```powershell
$env:PI_FILE_CHANGES_MODE = "watcher"
pi -e C:/absolute/path/to/pi-file-changes/dist/index.js
```

By default the package appends only a metadata-only `pi-file-changes` session
entry. Complete manifests are disabled. To opt in, set an absolute manifest
directory outside the working tree:

```powershell
$env:PI_FILE_CHANGES_MANIFEST_DIR = "C:\artifacts\pi-file-changes"
```

A complete manifest can contain non-redacted source and image bytes. Protect
that directory and apply your own retention policy.

## Host API

```ts
import { createFileChangeExtension } from "@jasmine-ai/pi-file-changes";

const extension = createFileChangeExtension({
  trackingMode: "managed-tools-only",
  onCapture(capture) {
    // Persist or render the host-neutral capture.
  },
  persistManifest: false,
  appendEntry: false
});
```

Watcher mode accepts `watchRoot`, either a string or a function of the Pi
extension context. It defaults to `ctx.cwd`.

## Performance contract

- No workspace traversal occurs in either mode.
- The temporary bare Git repository used to generate text diffs is created
  lazily, only after a successful managed edit actually changed captured text.
- `maxContentBytes` defaults to 8 MiB per observed file. Larger managed files
  retain path/status evidence with a structured coverage issue instead of being
  streamed to EOF.
- `maxRunCapturedContentBytes` defaults to 32 MiB,
  `maxManagedTargets` to 128, and `maxChanges` to 10,000.
- Watcher candidates are deduplicated by canonical path, and managed evidence
  wins when both modes observe the same file.

## Security and storage

The built-in sensitive-path and high-confidence content rules retain the path,
status, hash, size, and mode where available, while omitting preview bytes and
diffs. Hosts can add `shouldRedact` and `shouldRedactContent` predicates;
predicate failures redact fail-closed.

Normal baselines are held in memory. For changed, non-redacted managed text,
before/after bytes are written briefly as loose objects in an external
temporary bare Git repository to generate the unified diff, then the temporary
repository is removed. Sensitive or omitted content is never written there.

The package excludes `.git`, `node_modules`, and `.pi/file-changes`. Watcher
mode also passes these patterns to the native watcher backend.

## Protocol

The host-neutral `FileChangeCapture` contains:

- stable timestamps and `captureId`;
- added/modified/deleted counts;
- explicit tracking mode and Bash coverage semantics;
- exact managed targets and, in watcher mode, the watcher root;
- structured warnings/issues and bounded preview metadata;
- optional before/after text, image, and unified diff representations.

The custom Pi session entry is compact and never contains text, diffs, image
base64, or other preview bytes. Types and constants are also exported from
`@jasmine-ai/pi-file-changes/schema`.

## Development

```powershell
npm.cmd run check
npm.cmd pack --dry-run --json
```

The package is MIT licensed. `@parcel/watcher` is also MIT licensed.
