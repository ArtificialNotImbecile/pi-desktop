# Jasmine Test Harness

Jasmine combines unit tests, Electron E2E tests, a structured UI audit, generated visual evidence, and a headed acceptance run. Generated artifacts are local evidence and live under ignored `test-results/ui-harness/`.

## Commands

- `npm run build`: context-capture build, typecheck, renderer build, and Electron main build.
- `npm run test:unit`: database, runtime, Chrome bridge, icon, startup, stream, and context-capture checks.
- `npm run harness:check`: validates this test contract and UI implementation rules.
- `npm run harness:inspect`: writes the UI snapshot and audit under `test-results/ui-harness/inspect/`.
- `npm run harness:visual`: writes screenshots and a matrix under `test-results/ui-harness/visual/`.
- `npm run harness:accept`: runs the headed desktop acceptance path and writes `test-results/ui-harness/acceptance/`.
- `npm run test:e2e:smoke`: fast critical paths.
- `npm run test:e2e`: full Electron suite.
- `npm run harness:release`: complete build, unit, audit, visual, docs, E2E, and headed acceptance gate.
- `npm run readme:capture`: rebuilds the app, captures isolated page screenshots, and records the real-model Context Taxonomy GIF.
- `npm run dist:win`: builds the Windows x64 NSIS installer under ignored `release/v0.1.1/`.
- `npm run test:packaged`: launches `release/v0.1.1/win-unpacked/Jasmine.exe` and verifies the packaged renderer and bundled resources.

Use `npm.cmd` and `npx.cmd` on Windows.

## E2E map

- `startup.spec.ts`: bootstrap, hydration, and startup timing.
- `shell.spec.ts`: app shell, navigation, TODO, window controls, tray, overlays, and UI bridge.
- `threads.spec.ts`: thread lifecycle, drafts, projects, paging, and deletion.
- `composer.spec.ts`: rich editing, commands, attachments, paste, and render isolation.
- `providers.spec.ts`: provider settings, discovery, menus, labels, and options.
- `chat-runtime.spec.ts`: streaming, queueing, stop, traces, search, edit, and recovery.
- `settings.spec.ts`: settings shell, appearance, brand, language, and window states.
- `panels.spec.ts`: memory, activity, search, terminal, artifacts, and context.
- `integrations.spec.ts`: MCP, remotes, skills, prompts, and plugins.
- `rendering.spec.ts`: markdown, timelines, tool summaries, images, and actions.
- `spotlight.spec.ts`: global Spotlight launcher.

## Verification policy

- Use the smallest relevant spec while iterating, then run the broader gate once.
- Run the full E2E suite for shared shell, IPC, persistence, provider/runtime, or multi-workflow changes.
- Test the intended control and nearby non-control clicks for interaction fixes.
- Verify visible or persistent success/failure state for saves and updates.
- Restart Electron for persistence changes.
- Run `harness:visual` after material visual changes and inspect the generated matrix locally.
- Run `harness:accept` before a release; `harness:release` enforces its current generated result.
- Keep every checked inventory/workflow row backed by a test file or executable command.
