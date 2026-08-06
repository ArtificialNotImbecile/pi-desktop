# Jasmine Agent Instructions

These rules apply to coding agents working in this repository.

## Architecture boundaries

- Keep `src/renderer/App.tsx` focused on composition; put feature behavior in dedicated components, hooks, and services.
- Renderer code must not call provider APIs, filesystem APIs, shell APIs, or SQLite directly. Electron main owns services, persistence, secrets, filesystem access, and model/runtime orchestration.
- Keep shared IPC contracts, preload exposure, and main-process handlers synchronized.
- Do not display raw secrets in renderer UI or include secrets in logs, errors, snapshots, or test artifacts.
- Every visible control must perform a real action, show state, open UI, be disabled with a useful reason, or provide actionable feedback.

## Test contract

- Read `docs/harness.md` before changing shared shell, IPC, persistence, provider/runtime behavior, or test infrastructure.
- Update `docs/ui_inventory.md` for visible UI changes and `docs/workflow_inventory.md` for changed multi-step paths.
- Record currently reproducible UI defects in `docs/ui_issue_register.md`; do not add historical fix logs.
- Generated screenshots, traces, audits, and acceptance reports belong under ignored `test-results/`, never in Git.

When fixing a user-reported bug, identify why existing checks missed it and add a regression that exercises the exact observed failure. Verify every relevant variant of a repeated pattern.

## Verification

Use Windows commands `npm.cmd` and `npx.cmd`.

For a localized change, run:

- `npm.cmd run build`
- `npm.cmd run test:unit` when main services, database, runtime, or schemas change
- `npm.cmd run harness:check` when test-contract docs or UI rules change
- the smallest relevant Playwright spec or test-name grep

Run the full `npm.cmd run test:e2e` when a change touches shared app shell, IPC contracts, persistence, provider/model behavior, chat runtime, or multiple workflows. Run `npm.cmd run harness:release` before a release.

For app-level changes, launch Electron and confirm the page is nonblank. For persistence changes, restart Electron and verify restoration. For asynchronous refreshes, wait for the refreshed value rather than pre-existing DOM.
