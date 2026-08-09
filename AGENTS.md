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

### Off-screen E2E is mandatory

- Run routine Electron E2E through `npm.cmd run test:e2e`, `npm.cmd run test:e2e:smoke`, or `npx.cmd playwright test -c tests/playwright.config.ts ...`. The Playwright config defaults `JASMINE_E2E_OFFSCREEN=1`, so direct targeted runs stay transparent, non-focusable, outside the visible desktop, and out of the taskbar.
- Do not launch Electron manually for routine E2E. Any new E2E launcher must preserve `JASMINE_E2E_OFFSCREEN=1` from `process.env` and set `JASMINE_E2E_HARNESS=1` when it needs harness behavior.
- Use `npm.cmd run test:e2e:headed` only when visible interactive debugging is intentional. It explicitly clears `JASMINE_E2E_OFFSCREEN`. `npm.cmd run harness:accept` and `npm.cmd run harness:release` are also headed release paths; warn the user before running them when a visible window would be disruptive.
- After changing BrowserWindow creation, test launchers, Playwright configuration, or harness scripts, run `npm.cmd run harness:check` and the Spotlight off-screen window-state regression. That regression must confirm every Jasmine window is non-focusable, fully transparent, and not always-on-top.

For a localized change, run:

- `npm.cmd run build`
- `npm.cmd run test:unit` when main services, database, runtime, or schemas change
- `npm.cmd run harness:check` when test-contract docs or UI rules change
- the smallest relevant Playwright spec or test-name grep

Run the full `npm.cmd run test:e2e` when a change touches shared app shell, IPC contracts, persistence, provider/model behavior, chat runtime, or multiple workflows. Run `npm.cmd run harness:release` before a release.

For app-level changes, launch Electron and confirm the page is nonblank. For persistence changes, restart Electron and verify restoration. For asynchronous refreshes, wait for the refreshed value rather than pre-existing DOM.
