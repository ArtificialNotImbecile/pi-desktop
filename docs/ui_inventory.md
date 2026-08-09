# UI Inventory

Checked rows have reproducible automated evidence. Add a new row for a new major surface and link incomplete rows to the current issue register.

| Status | ID | Surface | Expected behavior | Evidence |
| --- | --- | --- | --- | --- |
| [x] | SHELL-001 | Main shell and sidebar | Navigation, window controls, overlays, TODO entry, tray behavior, and responsive shell remain usable. | `tests/e2e/shell.spec.ts` |
| [x] | CHAT-001 | Composer and active chat | Rich editing, commands, attachments, streaming, queueing, stopping, editing, and regeneration work; context usage matches Pi's JSONL usage, trailing-message estimate, and post-compaction unknown state. | `tests/e2e/composer.spec.ts`, `tests/e2e/chat-runtime.spec.ts`, `tests/unit/pi-context-usage.mjs` |
| [x] | THREAD-001 | Threads and projects | Threads, drafts, project scope, paging, search, and deletion persist correctly. | `tests/e2e/threads.spec.ts` |
| [x] | PROVIDER-001 | Providers and models | Provider setup, discovery, testing, selection, model labels, and options expose clear state. | `tests/e2e/providers.spec.ts` |
| [x] | SETTINGS-001 | Settings | General, appearance, brand, language, provider, integration, and window-state controls save visibly. | `tests/e2e/settings.spec.ts` |
| [x] | PANEL-001 | Work panels | Memory, activity, terminal, artifacts, context, and search panels retain correct ownership and state. | `tests/e2e/panels.spec.ts` |
| [x] | INTEGRATION-001 | Integrations | MCP, remote SSH, skills, prompt templates, and package plugins are manageable without exposing secrets. | `tests/e2e/integrations.spec.ts` |
| [x] | RENDER-001 | Message rendering | Markdown, code, native thinking, DeepSeek tool preambles, tools, images, traces, and actions are readable and accessible; live agent work stays visible while settled work collapses into a duration recap with the final answer left visible. | `tests/e2e/rendering.spec.ts`, `tests/e2e/chat-runtime.spec.ts` |
| [x] | SPOTLIGHT-001 | Spotlight | Global launcher focus, search, commands, routing, hiding, and restore behavior remain reliable. | `tests/e2e/spotlight.spec.ts` |
| [x] | VISUAL-001 | UI audit and visual matrix | Core surfaces expose structured controls without audit errors and can generate ignored visual evidence. | `npm run harness:inspect`, `npm run harness:visual` |
