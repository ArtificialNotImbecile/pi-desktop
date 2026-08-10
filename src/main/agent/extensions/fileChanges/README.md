# Pi File Changes

`@jasmine-ai/pi-file-changes` produces deterministic, changed-only filesystem
captures for Pi coding-agent runs. It is a data package: Pi CLI and SDK hosts
choose how to render, index, or retain its schema-v1 output.

The extension creates a baseline on `agent_start` and compares it with a final
snapshot on `agent_settled`. Status comes from the two snapshots, never from an
LLM summary or from Git repository state:

- a path present only after the run is `added`;
- a path present in both trees with different content or mode is `modified`;
- a path present only before the run is `deleted`;
- rename detection is disabled, so a move is always one deletion plus one add.

The tracked directory does not need to be a Git repository. Identity is
compared directly from snapshot maps (`SHA-256 + size + mode`); Git state, Git
object IDs, and `.gitignore` never decide A/M/D. Baseline snapshots are first
held in memory. To render unified diffs, each run writes the before and after
bytes for changed, non-redacted, non-omitted text as loose blobs in a temporary
bare Git store outside the tracked roots, then removes that store before
publishing the capture. Redacted or omitted content is never written there, and
nothing is written into a tracked root for snapshotting. The `git` executable
must be available on `PATH`; if initialization fails, the extension emits an empty capture with
`coverage.status: "failed"` instead of guessing.

## Pi CLI

Download the standalone package ZIP/TGZ from the Jasmine GitHub Release,
extract it, and use an absolute local path. Package discovery uses the
`pi.extensions` field in `package.json`:

```sh
pi install C:/absolute/path/to/pi-file-changes
```

For one run without persisting it in Pi settings:

```sh
pi -e C:/absolute/path/to/pi-file-changes/dist/index.js
```

Once `@jasmine-ai/pi-file-changes` is published to npm, the equivalent commands
will be:

```sh
pi install npm:@jasmine-ai/pi-file-changes
pi -e npm:@jasmine-ai/pi-file-changes
```

The package declares `@earendil-works/pi-coding-agent` as a `"*"` peer. This
follows the Pi package convention: Pi supplies the host runtime, while the
extension does not install a second, potentially incompatible runtime copy.

The default extension:

1. tracks `ctx.cwd`;
2. does **not** persist a full manifest;
3. appends a compact, metadata-only `pi-file-changes` custom entry to the
   session.

The custom entry contains status, paths, hashes, sizes, modes, coverage, and
an optional manifest path. It never contains source text, unified diffs, or
image base64.

Full manifests are an explicit retention opt-in. For the default CLI
extension, set `PI_FILE_CHANGES_MANIFEST_DIR` to an **absolute directory outside
the working root** before starting Pi. Relative paths and directories inside
`ctx.cwd` are rejected, leaving `manifestPath: null`. For example in
PowerShell:

```powershell
$env:PI_FILE_CHANGES_MANIFEST_DIR = "C:\artifacts\pi-file-changes"
pi -e C:/absolute/path/to/pi-file-changes/dist/index.js
```

The operator owns access control, retention, and deletion for that directory.
A full manifest can contain non-redacted source and images, and Windows does
not turn a Node `0600` mode request into a complete ACL policy.

## SDK and Jasmine hosts

Use the injectable factory when the host owns persistence and presentation:

```ts
import { createFileChangeExtension } from "@jasmine-ai/pi-file-changes";

const extension = createFileChangeExtension({
  roots: (ctx) => [ctx.cwd, "C:/another/explicit/root"],
  persistManifest: false,
  appendEntry: false,
  onCapture: async (capture) => {
    await artifactStore.save(capture);
  },
  shouldRedact: ({ path }) => path.endsWith(".customer-secret"),
  shouldRedactContent: ({ content }) => content.includes(Buffer.from("customer marker"))
});
```

`onCapture` receives only changed files, including bounded text/diff content
and image payloads. A host can set `persistManifest: false` and
`appendEntry: false` without changing tracking semantics.

## Coverage contract

- With no `roots` option, the baseline root is `ctx.cwd`.
- Supplying `roots` replaces that default. Relative roots resolve from
  `ctx.cwd`.
- Every `write` or `edit` tool path gets an exact-file baseline before the tool
  executes, even when it is lexically inside an existing recursive root. This
  prevents a traversal limit or read failure in the recursive snapshot from
  silently losing the managed file. If recursive and exact coverage overlap,
  a known run-start recursive baseline wins so a later `bash` then `edit` still
  reports the whole-run net change; exact-file coverage wins only when that
  initial recursive state was unknown. Sibling files are not pulled into the
  exact snapshot.
- Managed paths are canonicalized. Existing targets use their physical
  `realpath`; nonexistent targets use the nearest existing physical ancestor
  plus the missing suffix. A path such as `root/link/file.txt`, where `link`
  points outside `root`, is therefore tracked as the real external file.
- An explicitly configured symlink or junction directory is accepted:
  `coverage.roots[].path` preserves the logical requested path and
  `physicalPath` records the scanned target. Recursive traversal does not
  follow symlinks or junctions found inside a tree; a `write`/`edit` tool hook
  can still add their canonical target as exact-file coverage.
- Bash is intentionally different: shell changes are guaranteed only inside
  roots registered at `agent_start`. The package does not parse shell syntax,
  infer redirects, or guess paths created outside those roots. If any `bash`
  tool call occurs, `bashInvoked` is `true` and coverage is `partial`, even
  when there is no net change, because shell writes outside the listed roots
  are unobservable.
- A configured root that does not exist at baseline is known absent: creating
  it during the run reports additions. Deleting an existing root reports its
  previous files as deletions.

Coverage is a structured contract, not a message that consumers must parse:

- `status` is `complete`, `partial`, or `failed`; `reason` summarizes the first
  degradation and `partial` is retained as a compatibility boolean.
- `roots` records the stable id, logical and physical paths, source
  (`cwd`, `configured`, or `write-target`), scope (`recursive` or `file`),
  requested/canonical file paths, and whether bash is covered.
- `issues` records machine-readable codes, baseline/final stage, root, and
  affected path. `warnings` is human-readable supporting detail only.
- `limits` records the effective limits used for the capture;
  `bashCoverage`, `bashInvoked`, per-version Git-style `mode`, and `captureId`
  make the operating context explicit. Warning and issue arrays are bounded;
  `omittedWarningCount` and `omittedIssueCount` disclose discarded diagnostics.

The following paths are always excluded at any depth:

- `.git/**`
- `node_modules/**`
- `.pi/file-changes/**`

Ignored files are otherwise included. Existing `.gitignore` rules do not
change the capture.

Filesystem traversal is not an operating-system atomic snapshot. Tools run
after the baseline and settle before the final snapshot, but unrelated
processes modifying a covered root during traversal can also appear in the
result. The capture reports filesystem net changes, not tool attribution.

## Hard limits and incomplete snapshots

The factory exposes deterministic hard caps rather than relying on available
memory:

- `maxRoots` bounds configured recursive roots and `maxManagedTargets` bounds
  exact `write`/`edit` targets;
- `maxFiles` and `maxTotalBytes` bound each root snapshot; the byte limit is
  also enforced while streaming so a file cannot grow past its admitted size;
- `maxChanges` bounds the sorted changed-file result;
- `maxContentBytes` bounds retained content for one file,
  `maxCapturedContentBytes` bounds it per root snapshot, and
  `maxRunCapturedContentBytes` bounds it across the full run.

Hitting `maxRoots`, `maxManagedTargets`, `maxFiles`, `maxTotalBytes`, or
`maxChanges` produces a structured issue and makes coverage `partial`, because
path or identity observation was incomplete. If a snapshot is incomplete
because of a traversal or read failure, the extension suppresses additions or
deletions whose opposite side is unknown; it never converts missing evidence
into a guessed change.

Content caps affect preview retention, not identity observation. A changed file
over `maxContentBytes`, `maxCapturedContentBytes`, or
`maxRunCapturedContentBytes` remains a deterministic A/M/D record and sets
`contentOmitted: true` plus `contentOmittedReason`; it does not by itself make
coverage partial. Unchanged files that exceed preview budgets do not generate
warnings or issues.

## Content and secret handling

Every before/after version records SHA-256, byte size, and Git-style mode.
Changes are sorted by normalized root and relative path.

- Valid UTF-8 files provide before/after text and a Git unified diff.
  Before/after text defaults to 256 KiB per side and diff output defaults to
  512 KiB. Each value exposes its original `byteSize` and `truncated` flag.
- PNG, JPEG, GIF, WebP, BMP, and ICO files provide before/after base64 plus
  media type.
- Other files provide metadata only.
- Files over a content-retention cap still provide status, SHA-256, size, and
  mode. They set `contentOmitted: true` and `contentOmittedReason`, and contain
  no text, diff, or base64.

Obvious secret filenames are always redacted, case-insensitively:
`.env*`, `.npmrc`, `.pypirc`, `.netrc`, `auth.json`, `*.pem`, `*.key`,
`*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`,
and boundary-delimited `credential`, `credentials`, `secret`, `secrets`, or
`token` names such as `credentials.json`, `access-token.json`, and
`token.production`. Prefix lookalikes such as `tokens.ts`, `tokenizer.ts`, and
`credentialsHelper.ts` are not filename matches. Status, hash, size, and mode
remain available, but text, image content, and unified diff are absent and
`redacted` is `true`.

A deterministic high-confidence content gate also redacts PEM private-key
blocks, known token families (`sk-`, `ghp_`, `github_pat_`, `xox*`, `AKIA`,
`AIza`, and `npm_`), `Authorization: Bearer` values, and concrete
`api_key`/`token`/`password`/`secret`/`client_secret`/`private_key`
assignments in JSON, YAML, env, and source configuration. Placeholders such as
`${API_KEY}`, `changeme`, and `redacted` are not treated as concrete values. If
either before or after matches, the whole change is redacted on both sides.
Those raw versions are never written to the temporary Git store, manifest,
session entry, or callback payload.

`shouldRedact` and `shouldRedactContent` can add host-specific path and content
rules. They are additive: they cannot turn off built-ins. Content predicates
receive retained bytes (or a bounded sample with `contentTruncated: true` when
preview retention is already capped). If either predicate throws, the file is
redacted fail-closed and the failure is recorded in `coverage.warnings`.

Factory users may explicitly set `persistManifest: true` and
`manifestDirectory`; unlike the CLI environment opt-in, factory configuration
can choose an in-root directory. Such hosts own its access control and
retention. Session entries remain metadata-only in every mode.

## Temporary data and cleanup

The extension removes its per-run bare repository before publishing the
capture and also tries again during session shutdown. A process crash or an
unrecoverable filesystem cleanup error can leave a `pi-file-changes-*`
directory in the operating-system temporary directory; cleanup errors are
reported as partial coverage or logged when no capture can be updated. The
package deliberately has no age-based janitor: it cannot safely prove that an
older directory is not owned by another live process. Normal OS temporary-file
maintenance may remove crash residue.

## Schema stability

The serialized capture and compact entry use `schemaVersion: 1`. Consumers
should reject unknown major schema versions instead of guessing. Public schema
types and constants are exported from `@jasmine-ai/pi-file-changes/schema`.

## Development

```sh
npm run check
npm pack --dry-run
```

The test suite uses temporary non-Git directories and covers additions,
edits, deletions, shell-style net changes, image payloads, cross-root write
targets, exact-file precedence, symlink/junction canonicalization,
delete-plus-add move semantics, root creation/deletion, hard limits, incomplete
reads, content redaction/omission, filenames with spaces, Git initialization
failure, compact-entry safety, and a 1,000-file performance regression.
The suite also changes 100 text files at once to enforce root-batched rather
than per-file Git diff processes.
