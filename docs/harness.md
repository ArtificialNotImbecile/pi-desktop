# Jasmine Test Harness

Jasmine combines unit tests, renderer tests, Electron E2E tests, a structured UI audit, generated visual evidence, and a headed acceptance run. Generated artifacts are local evidence and live under ignored `test-results/ui-harness/`.

## Commands

- `npm run build`: extension package builds, typecheck, renderer build, and Electron main build.
- `npm run test:unit`: database, runtime, icon, startup, stream, updater,
  permission, and context-capture checks. The root runner consumes the compiled
  app and extension outputs from the preceding `npm run build`; extension
  packages that expose a standalone `npm test` remain self-building for
  package-local development.
- `npm run test:renderer`: Vitest + jsdom over `tests/renderer/`. Mounts real
  components and hooks against a fake desktop bridge, with no Electron and no
  display. The full suite finishes in seconds rather than Electron-suite
  minutes, so it is the default home for renderer state; see the layer split in
  `AGENTS.md`.
- `npm run harness:check`: validates this test contract and UI implementation rules.
- `npm run harness:inspect`: writes the UI snapshot and audit under `test-results/ui-harness/inspect/`.
- `npm run harness:visual`: writes screenshots and a matrix under `test-results/ui-harness/visual/`.
- `npm run harness:accept`: runs the headed desktop acceptance path and writes `test-results/ui-harness/acceptance/`.
- `npm run test:e2e:smoke`: fast critical paths in background/off-screen mode.
- Four cases across three spec files are tagged `@desktop-session` and are
  skipped by CI's Full E2E job through
  `JASMINE_E2E_SKIP_DESKTOP_SESSION=1`. They assert window maximize/minimize,
  model-menu geometry, terminal resize/session, and Working notification
  behavior that a CI runner cannot perform: they failed on Linux and macOS alike, in partly
  different sets, while passing locally. A local `npm run test:e2e` still runs
  them. Retiring the tag means either covering those assertions in renderer
  tests or giving CI a session that can satisfy them -- not simply re-enabling
  them.
- Another case was split that first way. The settings window is a div, not an OS
  window, so its pointer arithmetic, drag guards, minimize, and maximize state
  live in `tests/renderer/settingsWindowChrome.test.tsx` and run everywhere.
  One `boundingBox()` drag assertion remains folded into an existing settings
  E2E case: jsdom cannot prove that the real CSS honors the resulting left/top
  values, and folding it avoids another Electron launch. The remaining four
  tagged cases need real layout, a PTY, or a real window manager, and a renderer
  test cannot stand in for them.
- `npm run test:e2e`: full Electron suite in background/off-screen mode.
- `npm run test:e2e:main` / `npm run test:e2e:serial`: the two halves CI runs as
  separate jobs. `test:e2e:main` accepts `-- --shard=i/2`. `--shard` cannot be
  applied to the whole config, because the projects that declare `dependencies`
  make Playwright put every test in the first shard; sharding the `main` project
  alone splits evenly, and `test:e2e:serial` runs the rest with `--no-deps`.
- `npm run test:e2e:headed`: explicit foreground run for interactive debugging.
- `npm run harness:release`: complete build, unit, audit, visual, docs, E2E, and headed acceptance gate.
- `npm run readme:capture`: rebuilds the local app by default, captures isolated page screenshots from one real model turn, and records the two-turn real-model Context Taxonomy GIF. Set `JASMINE_README_EXECUTABLE` and `JASMINE_README_EXPECTED_VERSION` to record a specific installed release instead.
- `npm run dist:win`: builds the Windows x64 NSIS installer under the versioned output directory configured in `package.json`.
- `npm run dist:linux`: builds Linux x64 AppImage and deb packages. Run it on Linux.
- `npm run dist:mac:arm64`: builds the Apple Silicon macOS DMG. Run it on macOS.
- `npm run test:packaged`: launches the current platform's unpacked Jasmine executable and verifies the packaged renderer, bundled resources, database migration, and terminal.

Use `npm.cmd` and `npx.cmd` on Windows.

Normal E2E commands create transparent, non-focusable Electron windows outside the visible desktop and keep them out of the taskbar. This includes direct targeted commands that use `tests/playwright.config.ts`, `harness:inspect`, `harness:visual`, and the secondary Spotlight window, so the suite can run without covering apps or stealing keyboard focus. The test launchers default `JASMINE_E2E_OFFSCREEN=1`; `test:e2e:headed` explicitly clears it and should be used only when a visible interactive run is intentional. `harness:accept` remains a headed release-acceptance path and explicitly opts out of off-screen mode.

## E2E map

- `startup.spec.ts`: bootstrap, hydration, startup timing, and native-history isolation.
- `shell.spec.ts`: app shell, navigation, About access, window controls, tray, overlays, and UI bridge.
- `threads.spec.ts`: thread lifecycle, durable drafts, projects, reading intent, and deletion.
- `composer.spec.ts`: rich editing, commands, attachments, paste, and render isolation.
- `providers.spec.ts`: real menu/settings geometry, direct-secret persistence, and runtime model labels.
- `chat-runtime.spec.ts`: streaming, queueing, stop, traces, search, edit, and recovery.
- `settings.spec.ts`: settings shell geometry, brand restart persistence, language/executables, and minimum-window layout.
- `updater.spec.ts`: the real About-to-main update check, download, restart-to-install bridge, and manual browser hand-off.
- `panels.spec.ts`: memory, activity, command routing, terminal, deterministic file-change artifacts/diffs/previews, and context.
- `integrations.spec.ts`: skills, prompts, Pi packages, and retired built-in migration.
- `rendering.spec.ts`: real Shiki/Markdown paint, timelines, lazy tool details, layout, scroll behavior, restart restoration, and DOM identity.
- `streaming-markdown.spec.ts`: cumulative Markdown chunk stability, late tool classification, and continuously growing fenced code.
- `message-jump-rail.spec.ts`: stable jump-target observation and a layout-read-free scroll hot path.
- `spotlight.spec.ts`: global Spotlight launcher.
- `working.spec.ts`: task-state routing, controls, viewed-chat hidden/minimized notifications and unread fallback, and card geometry.
- `permissions.spec.ts`: permission-mode persistence, project scope, approval decisions, sender binding, reload, and cancellation.

## Unit infrastructure checks

- `test-infrastructure.mjs`: portable, collision-resistant E2E user-data
  directory names and Vite's fixed strict development-server port. These are
  pure Node/config checks and do not belong in the Playwright project count.
- `i18n-parity.mjs`: shared English/Chinese dictionary parity, translated
  activity labels, explicit renderer locales for dates/numbers, and a source
  guard that rejects literal accessible attributes, interpolated labels, and
  control names outside the fixed-language UI catalogue fixture.

## Renderer test map

- `settingsWindowChrome.test.tsx`: settings panel drag arithmetic, drag suppression, minimize, maximize, and restore; real drag geometry stays in `settings.spec.ts`.
- `chatMessagePaging.test.tsx`: first-page selection, older-history paging and its cursor, in-flight and thread-switch guards.
- `chatMessageReconciliation.test.tsx`: thread switching, stale page reads, settlement precedence, and provider-failure state.
- `chatMessageRuns.test.tsx`: cross-thread completion and rapid-run promotion without duplicate optimistic rows.
- `providerSettings.test.tsx`: provider/settings controls, section routing, update payloads, and validation.
- `shellComponents.test.tsx`, `surfaceDismissal.test.tsx`, and `reducedMotion.test.tsx`: question/search surfaces, overlay dismissal, and reduced-motion transitions.
- `updaterPage.test.tsx`: manual-download and up-to-date About rendering; the cross-process browser hand-off and its failure state stay in `updater.spec.ts`.
- `streamTransitions.test.ts`: cumulative stream snapshots compact into replayable deltas.
- `composerClipboard.test.tsx`: synthetic image `File` clipboard payloads; the native OS clipboard stays in E2E.
- `threadDraftPersistence.test.tsx`: deterministic delayed-draft hydration and immediate typing.
- `commandPalette.test.tsx` and `navigation.test.tsx`: command/shortcut routing, UI catalog interactions, route serialization, and browser-style navigation history.
- `rightPanelTabs.test.ts`: terminal-tab display-name allocation without launching a desktop shell.
- `messageRendering.test.tsx`: message actions, tool summaries, decoded errors, and image lightboxes through the real `MessageView`; Shiki, layout, scroll, paint timing, and DOM identity stay in E2E.
- `chatPanelI18n.test.ts`: English-stable and Chinese-localized short artifact timestamps without launching Electron.
- `fakeBridge.ts`: the fake `window.jasmine`. It mirrors the repository's
  `(created_at, rowid)` paging order, can hold and release a `listMessages`
  reply to reproduce an out-of-order IPC response deterministically, returns
  type-checked real-contract response shapes, and throws by name for any method
  it does not model.

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
