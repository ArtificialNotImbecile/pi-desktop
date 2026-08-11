# UI Coverage Matrix

## Release gates

| ID | Gate | Evidence |
| --- | --- | --- |
| GATE-001 | Build and typecheck pass. | `npm run build` |
| GATE-002 | Unit suites pass. | `npm run test:unit` |
| GATE-003 | Test-contract docs and UI rules pass. | `npm run harness:check` |
| GATE-004 | Structured UI audit reports zero errors. | `npm run harness:inspect` |
| GATE-005 | Full Electron E2E passes. | `npm run test:e2e` |
| GATE-006 | Current headed acceptance result passes. | `npm run harness:accept` |
| GATE-007 | Complete release command passes without tracked artifacts. | `npm run harness:release` |

## Risk coverage

| ID | Risk | Automated coverage | Workflow coverage | Evidence |
| --- | --- | --- | --- | --- |
| RISK-001 | Visible controls are inert, ambiguous, or accidentally activated. | `SHELL-001`, `SETTINGS-001` | `WF-002`, `WF-004` | `tests/e2e/shell.spec.ts`, `tests/e2e/settings.spec.ts` |
| RISK-002 | Provider, model, or streaming state is incorrect or mutable after send. | `PROVIDER-001`, `CHAT-001` | `WF-001`, `WF-002` | `tests/e2e/providers.spec.ts`, `tests/e2e/chat-runtime.spec.ts` |
| RISK-003 | Persistence or project scope crosses thread/user boundaries. | `THREAD-001`, `PANEL-001` | `WF-002`, `WF-005`, `WF-007`, `WF-015` | `tests/e2e/threads.spec.ts`, `tests/e2e/panels.spec.ts`, `tests/unit/database-smoke.mjs` |
| RISK-004 | Secrets or privileged integrations leak data or bypass main-process ownership. | `INTEGRATION-001`, `PROVIDER-001`, `PANEL-001` | `WF-001`, `WF-006`, `WF-009`, `WF-015` | `tests/e2e/integrations.spec.ts`, `tests/unit/pi-runtime-equivalence.mjs`, `src/main/agent/extensions/fileChanges/tests/file-changes.test.mjs` |
| RISK-005 | Rich content, tools, traces, or file changes are inaccessible or misleading. | `RENDER-001`, `PANEL-001` | `WF-003`, `WF-009`, `WF-015` | `tests/e2e/rendering.spec.ts`, `tests/e2e/panels.spec.ts` |
| RISK-006 | Window state, focus, overlays, or responsive layout hide critical actions. | `SHELL-001`, `SPOTLIGHT-001` | `WF-004`, `WF-008` | `tests/e2e/shell.spec.ts`, `tests/e2e/spotlight.spec.ts` |
| RISK-007 | Automated behavior passes while visible layout is broken. | `VISUAL-001` | `WF-010` | `npm run harness:visual`, `npm run harness:accept` |
| RISK-008 | A repeat launch opens a second window, or crashes the instance that should hand off silently. | `STARTUP-001` (partial: the pre-ready race is manual only, since exit codes and stderr stay clean while the error surfaces as a modal dialog) | — | `tests/e2e/startup.spec.ts` |
