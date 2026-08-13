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
- `npm.cmd run test:renderer` when renderer components or hooks change
- `npm.cmd run harness:check` when test-contract docs or UI rules change
- the smallest relevant Playwright spec or test-name grep

### Which layer a test belongs in

`npm.cmd run test:renderer` (Vitest + jsdom, `tests/renderer/`) mounts real
components and hooks against a fake desktop bridge, with no Electron. The whole
suite runs in under two seconds, so prefer it whenever the behavior under test is
renderer state: message reconciliation, pagination, run and error states, panel
chrome, menu and form logic. `tests/renderer/fakeBridge.ts` models the IPC
surface; add to it rather than reaching for a real bridge, and note that an
unmodeled method throws by name instead of resolving undefined.

Keep a case in `tests/e2e/` when it needs something jsdom does not have: real
layout (`boundingBox`, `toBeInViewport`, scroll positions, element geometry), a
PTY or clipboard, actual paint timing, DOM node identity across a re-render,
persistence across a restart, or a second BrowserWindow. jsdom has no layout
engine, so geometry there reads as zero and a test that reaches for it fails
uninformatively rather than catching anything.

When sinking an E2E case, confirm the new test fails against the bug it is meant
to catch before trusting it. Reintroduce the defect, watch the assertion go red,
then restore. Assertions that read state the component sets unconditionally --
an inline style a maximized panel never carries, a row a refetch restores anyway
-- pass whether or not the behavior works, and several only revealed themselves
this way.

CI owns the full E2E suite, split across four jobs: three `Full E2E (i/3)` shards
of the `main` Playwright project, plus `Full E2E (serial projects)` for the
focus-sensitive and startup-timing projects. Do not run the whole suite locally as
routine verification: CI reruns it on the exact commit anyway. Locally, run the
smallest spec or `--grep` that covers your change and let CI catch the rest.

Every E2E test launches its own Electron instance, so roughly 2s of each ~4.6s
test is process startup. That makes test count, not assertion count, the thing
that costs wall-clock time — prefer adding coverage in `tests/renderer/`.

Run the full `npm.cmd run test:e2e` locally only when you have a specific reason —
debugging a failure CI reported, or a change to the harness or Playwright config
itself, where a broken suite would not report honestly from CI. Run
`npm.cmd run harness:release` before a release.

Never mark work finished on the strength of a local partial run alone. Say which
checks you ran, and that the full suite is CI's to confirm.

For app-level changes, launch Electron and confirm the page is nonblank. For persistence changes, restart Electron and verify restoration. For asynchronous refreshes, wait for the refreshed value rather than pre-existing DOM.

## Change workflow

Land every change through a pull request; do not commit to `main` directly.

1. Open the PR, then request a review by commenting `@codex review`.
2. Fix what the review finds, push, and request another review.
3. Repeat until a review reports no findings on the current head commit.
4. Merge only when that clean review and every CI check are green.

### Reading Codex review results

Codex reports through two different GitHub surfaces, and which one it uses depends on the outcome. Check both, every time:

| Outcome | Where it lands | API |
| --- | --- | --- |
| Findings | a PR review whose findings are inline comments | `/pulls/:n/reviews` and `/pulls/:n/comments` |
| No findings | an issue comment, `Codex Review: Didn't find any major issues` | `/issues/:n/comments` |

Two failure modes follow from that split, and both have caused wrong conclusions:

- A review's own body is boilerplate ("Here are some automated review suggestions"). Its findings live only in the inline comments, so a review is not clean just because its body says nothing.
- A clean pass never adds an entry to the reviews list. Waiting for the review count to grow means waiting for a signal that cannot arrive.

Decide by the `Reviewed commit:` SHA in the comment body, which tells you which head the result applies to. Never decide by a counter.

## Compatibility

Jasmine is pre-1.0 and in active development, so backward compatibility is not a design constraint. Migrations may drop retired tables and columns outright, removed features need no data-preservation path, and state a removed feature owned can go with it. Prefer the simplest change that leaves the app correct going forward over machinery that preserves data nothing reads.
