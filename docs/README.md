# Jasmine documentation

### The desktop app for Pi

Jasmine is an independent, open-source desktop GUI for the Pi coding agent. It combines Pi-compatible sessions, coding-agent interactions, skills, extensions, and integrated terminal workflows in a modern desktop app.

Jasmine is a community-built project and is not affiliated with or endorsed by Pi.

## Guides

- [Pi session storage](session_storage.md) — canonical JSONL history, SQLite projections, branching, and recovery.
- [Import Pi sessions](pi_session_import.md) — preview and import existing Pi coding-agent sessions.
- [Reasoning context retention](reasoning_context_retention.md) — provider-specific reasoning replay behavior.
- [UI harness](harness.md) — build, test, visual inspection, and release verification.
- [开发与发版流程](development-and-release.md) — 普通提交 CI、手动跨平台预构建和正式 Release 的职责边界与操作步骤。
- [UI inventory](ui_inventory.md) — visible product surfaces and their automated evidence.
- [Workflow inventory](workflow_inventory.md) — multi-step desktop workflows and coverage.
- [Roadmap](roadmap.md) — capabilities intentionally kept out of the app and what they must prove as standalone Pi extensions first.

## Development

From the `pi-desktop` repository root on Windows:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run test:unit
npm.cmd run test:e2e:smoke
```
