# Jasmine Test Harness

Jasmine combines unit tests, renderer tests, Electron E2E tests, a structured UI audit, generated visual evidence, and a headed acceptance run. Generated artifacts are local evidence and live under ignored `test-results/ui-harness/`.

## Commands

- `npm run build`: context-capture build, typecheck, renderer build, and Electron main build.
- `npm run test:unit`: database, runtime, icon, startup, stream, updater, permission, and context-capture checks.
- `npm run test:renderer`: Vitest + jsdom over `tests/renderer/`. Mounts real
  components and hooks against a fake desktop bridge, with no Electron and no
  display. The full suite finishes in about a second and a half, so it is the
  default home for renderer state; see the layer split in `AGENTS.md`.
- `npm run harness:check`: validates this test contract and UI implementation rules.
- `npm run harness:inspect`: writes the UI snapshot and audit under `test-results/ui-harness/inspect/`.
- `npm run harness:visual`: writes screenshots and a matrix under `test-results/ui-harness/visual/`.
- `npm run harness:accept`: runs the headed desktop acceptance path and writes `test-results/ui-harness/acceptance/`.
- `npm run test:e2e:smoke`: fast critical paths in background/off-screen mode.
- Five specs are tagged `@desktop-session` and are skipped by CI's Full E2E job
  through `JASMINE_E2E_SKIP_DESKTOP_SESSION=1`. They assert window maximize,
  minimize, restore, window drags, and pointer-driven panel resizes, which a CI
  runner cannot perform: they failed on Linux and macOS alike, in partly
  different sets, while passing locally. A local `npm run test:e2e` still runs
  them. Retiring the tag means either covering those assertions in renderer
  tests or giving CI a session that can satisfy them -- not simply re-enabling
  them.
- The sixth was retired that first way. The settings window is a div, not an OS
  window: its drag, minimize, and maximize are React state and clientX/clientY
  arithmetic, so that case now lives in
  `tests/renderer/settingsWindowChrome.test.tsx` and runs everywhere. The
  remaining five need real layout, a PTY, or a real window manager, and a
  renderer test cannot stand in for any of them.
- `npm run test:e2e`: full Electron suite in background/off-screen mode.
- `npm run test:e2e:headed`: explicit foreground run for interactive debugging.
- `npm run harness:release`: complete build, unit, audit, visual, docs, E2E, and headed acceptance gate.
- `npm run readme:capture`: rebuilds the app, captures isolated page screenshots, and records the real-model Context Taxonomy GIF.
- `npm run dist:win`: builds the Windows x64 NSIS installer under the versioned output directory configured in `package.json`.
- `npm run dist:linux`: builds Linux x64 AppImage and deb packages. Run it on Linux.
- `npm run dist:mac:arm64`: builds the Apple Silicon macOS DMG. Run it on macOS.
- `npm run test:packaged`: launches the current platform's unpacked Jasmine executable and verifies the packaged renderer, bundled resources, database migration, and terminal.

Use `npm.cmd` and `npx.cmd` on Windows.

Normal E2E commands create transparent, non-focusable Electron windows outside the visible desktop and keep them out of the taskbar. This includes direct targeted commands that use `tests/playwright.config.ts`, `harness:inspect`, `harness:visual`, and the secondary Spotlight window, so the suite can run without covering apps or stealing keyboard focus. The test launchers default `JASMINE_E2E_OFFSCREEN=1`; `test:e2e:headed` explicitly clears it and should be used only when a visible interactive run is intentional. `harness:accept` remains a headed release-acceptance path and explicitly opts out of off-screen mode.

## E2E map

- `startup.spec.ts`: bootstrap, hydration, startup timing, and native-history isolation.
- `shell.spec.ts`: app shell, navigation, About access, window controls, tray, overlays, and UI bridge.
- `threads.spec.ts`: thread lifecycle, drafts, projects, paging, and deletion.
- `composer.spec.ts`: rich editing, commands, attachments, paste, and render isolation.
- `providers.spec.ts`: provider settings, discovery, menus, labels, and options.
- `chat-runtime.spec.ts`: streaming, queueing, stop, traces, search, edit, and recovery.
- `settings.spec.ts`: settings shell, appearance, brand, language, and window states.
- `updater.spec.ts`: About version state plus manual check, download, and restart-to-install transitions.
- `panels.spec.ts`: memory, activity, search, terminal, deterministic file-change artifacts/diffs/previews, and context.
- `integrations.spec.ts`: skills, prompts, Pi packages, and retired built-in migration.
- `rendering.spec.ts`: markdown, timelines, tool summaries, images, actions, long-history render isolation, and tail-follow completion.
- `streaming-markdown.spec.ts`: cumulative Markdown chunk stability, late tool classification, and continuously growing fenced code.
- `message-jump-rail.spec.ts`: stable jump-target observation and a layout-read-free scroll hot path.
- `spotlight.spec.ts`: global Spotlight launcher.
- `working.spec.ts`: task-state routing, controls, viewed-chat hidden/minimized notifications and unread fallback, and card geometry.
- `permissions.spec.ts`: permission-mode persistence, project scope, approval decisions, sender binding, reload, and cancellation.

## Renderer test map

- `settingsWindowChrome.test.tsx`: settings panel drag, drag suppression, minimize, maximize, and restore.
- `chatMessagePaging.test.tsx`: first-page selection, older-history paging and its cursor, in-flight and thread-switch guards.
- `chatMessageReconciliation.test.tsx`: thread switching, stale page reads, settlement precedence, and provider-failure state.
- `fakeBridge.ts`: the fake `window.jasmine`. It mirrors the repository's
  `(created_at, rowid)` paging order, can hold and release a `listMessages`
  reply to reproduce an out-of-order IPC response deterministically, and throws
  by name for any method it does not model.

## Verification policy

- Use the smallest relevant spec while iterating, then run the broader gate once.
- Put renderer state in `tests/renderer/` and keep layout, PTY, clipboard, paint
  timing, node identity, restart, and second-window behavior in `tests/e2e/`.
- Before trusting a sunk test, reintroduce the defect it targets and confirm it
  goes red.
- Run the full E2E suite for shared shell, IPC, persistence, provider/runtime, or multi-workflow changes.
- Test the intended control and nearby non-control clicks for interaction fixes.
- Verify visible or persistent success/failure state for saves and updates.
- Restart Electron for persistence changes.
- Run `harness:visual` after material visual changes and inspect the generated matrix locally.
- Run `harness:accept` before a release; `harness:release` enforces its current generated result.
- A tagged release must also pass the native packaged smoke in `.github/workflows/release.yml` for Windows, Linux, and Apple Silicon macOS before GitHub Release publication.
- Keep every checked inventory/workflow row backed by a test file or executable command.
