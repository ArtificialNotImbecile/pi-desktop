# Import Pi sessions

Jasmine imports a Pi session without translating away its native record. The original JSONL file is copied byte-for-byte into Jasmine-owned Pi session storage and bound to a thread by session UUID. This preserves the full Pi tree, including inactive branches, compaction records, reasoning signatures, tool calls, extension entries, and session metadata.

SQLite is a UI projection: the current Pi branch becomes searchable and pageable Jasmine messages, and each projected row records its source JSONL entry ID. Each Pi working directory becomes a Jasmine project. Tool-result images are extracted to `~/.jasmine/data/pi-import-assets/` for UI display; the original image blocks remain in JSONL.

The importer is read-only unless `--write` is supplied. A write run creates a consistent SQLite backup under `~/.jasmine/data/backups/` before copying files and opening its transaction. Pi session UUIDs are reused as Jasmine thread UUIDs, so rerunning the same command skips sessions already imported.

Use `--replace` together with `--write` only when an already imported session needs a refreshed UI projection. Replacement is transactional and creates a new backup. The JSONL copy must either be absent or byte-identical; the importer refuses to overwrite a different file.

Preview one session:

```powershell
npm.cmd run import:pi-sessions -- --session "C:\Users\luo\.pi\agent\sessions\--C--Users-luo--\2026-08-06T07-29-43-846Z_019fd5fa-61a6-77f4-9cd3-7c2ccf175546.jsonl"
```

Import it after reviewing the preview:

```powershell
npm.cmd run import:pi-sessions -- --session "C:\Users\luo\.pi\agent\sessions\--C--Users-luo--\2026-08-06T07-29-43-846Z_019fd5fa-61a6-77f4-9cd3-7c2ccf175546.jsonl" --write
```

Preview or import every session below `~/.pi/agent/sessions`:

```powershell
npm.cmd run import:pi-sessions -- --all
npm.cmd run import:pi-sessions -- --all --write
```

Use `--database`, `--source-root`, `--asset-root`, `--session-root`, and `--backup-directory` to override defaults. Open the database once with the current Jasmine version before importing so the JSONL binding columns exist.
