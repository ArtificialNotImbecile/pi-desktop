# Jasmine

Jasmine (**Just Another Self Mine**) is a local-first desktop workspace for AI-assisted chat, projects, tools, and personal context. The application is built with Electron, React, TypeScript, Pi, JSONL session files, and SQLite.

![Jasmine main workspace](docs/assets/screenshots/main.png)

## Features

- Persistent local threads, messages, drafts, projects, TODOs, memories, and activity records.
- Multiple OpenAI-compatible providers with model discovery and per-model options.
- Rich chat rendering, attachments, prompt templates, skills, plugins, MCP servers, remote shells, and local project context.
- Optional Chrome integration for user-directed browser automation.
- English and Chinese interface copy, appearance settings, Spotlight launcher, and a structured UI test harness.

Jasmine stores application data locally, but configured AI providers, web search tools, MCP servers, remote hosts, and browser automation can send data outside the computer. Review each integration before enabling it.

Pi-compatible JSONL is the canonical model conversation record. SQLite remains the transactional projection for thread lists, search, UI paging, settings, traces, and links back to JSONL entry IDs. See [session storage](docs/session_storage.md) and [Pi session import](docs/pi_session_import.md).

## Context inspection

Jasmine exposes each model request as a readable context taxonomy. The latest user task shows every provider subrequest (`1/N`) in wire order, with text, reasoning, tool calls/results, provider options, payload shape, actual usage, estimated composition, and DeepSeek/Kimi reasoning-retention validation. Sanitized raw payloads are gzip-backed and loaded only when expanded.

![Inspecting a real DeepSeek request in Context Taxonomy](docs/assets/context-taxonomy.gif)

The example above uses two real model turns and opens the captured conversation context and provider request. See [reasoning context retention](docs/reasoning_context_retention.md) for the provider-specific DeepSeek and Kimi rules that determine which historical thinking blocks must be replayed.

## Product tour

<details>
<summary>Workspace, local context, and project tools</summary>

| TODOs | Search |
| --- | --- |
| ![Project TODOs](docs/assets/screenshots/todo.png) | ![Search chats](docs/assets/screenshots/search.png) |
| Memory | Activity |
| ![Local memory](docs/assets/screenshots/memory.png) | ![Local activity](docs/assets/screenshots/activity.png) |
| Artifacts | Terminal |
| ![Conversation artifacts](docs/assets/screenshots/artifacts.png) | ![Project terminal](docs/assets/screenshots/terminal.png) |

</details>

<details>
<summary>Settings and integrations</summary>

| General | Providers |
| --- | --- |
| ![General settings](docs/assets/screenshots/settings-general.png) | ![Provider settings](docs/assets/screenshots/settings-providers.png) |
| Appearance | Memory |
| ![Appearance settings](docs/assets/screenshots/settings-appearance.png) | ![Memory settings](docs/assets/screenshots/settings-memory.png) |
| Skills | Plugins |
| ![Skill settings](docs/assets/screenshots/settings-skills.png) | ![Plugin settings](docs/assets/screenshots/settings-plugins.png) |
| Chrome Control | Prompt Templates |
| ![Chrome Control settings](docs/assets/screenshots/settings-chrome.png) | ![Prompt template settings](docs/assets/screenshots/settings-prompt-templates.png) |
| Remote | MCP Servers |
| ![Remote settings](docs/assets/screenshots/settings-remote.png) | ![MCP server settings](docs/assets/screenshots/settings-mcp.png) |
| Activity | Web Search |
| ![Activity settings](docs/assets/screenshots/settings-activity.png) | ![Web Search settings](docs/assets/screenshots/settings-web-search.png) |
| About | |
| ![About Jasmine](docs/assets/screenshots/settings-about.png) | |

</details>

## Requirements

- Windows 10 or later
- Node.js 22
- npm

## Install on Windows

Download the current x64 installer from [GitHub Releases](https://github.com/ArtificialNotImbecile/jasmine/releases/latest). The `v0.1.1` installer is not code-signed, so Windows may show a SmartScreen warning. Verify the published SHA-256 checksum before running it.

## Run locally

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

Development mode:

```powershell
npm.cmd run dev
```

Electron stores Jasmine data in the operating system's application-data directory. Tests use isolated temporary user-data directories and do not reuse the normal profile.

## Provider credentials

Environment-variable references are the recommended credential method. For example, configure a provider with `env:DEEPSEEK_API_KEY` and set that variable in the operating system before launching Jasmine.

Jasmine also supports entering a key directly. Direct keys are stored as plain text in the local SQLite database. They are masked in renderer-visible settings, but they are not protected by the operating system credential vault. Do not use direct storage on an untrusted or shared computer.

## Chrome integration

The optional Chrome extension uses `debugger`, `tabs`, `nativeMessaging`, `scripting`, and `<all_urls>` permissions so Jasmine can control a browser only when the integration is enabled and invoked. Disable the Chrome package in Settings and remove the extension/native host to turn the integration off.

The Chrome integration, extension source, and Jasmine visual assets in this repository are project-owned or authorized for distribution under the MIT License.

## Testing

Common checks:

```powershell
npm.cmd run build
npm.cmd run test:unit
npm.cmd run harness:check
npm.cmd run test:e2e:smoke
```

Run `npm.cmd run test:e2e` for the full Electron suite in background/off-screen mode. It keeps test windows transparent, non-focusable, and out of the taskbar; use `npm.cmd run test:e2e:headed` only for intentional foreground debugging. Run `npm.cmd run harness:release` for the complete local release gate; its final acceptance stage is intentionally headed. Generated screenshots, traces, audits, and acceptance results are written under ignored `test-results/` paths.

Regenerate the README screenshots and real-model taxonomy GIF with `npm.cmd run readme:capture`. This command uses `DEEPSEEK_API_KEY` for two live requests. Build the Windows installer with `npm.cmd run dist:win` and validate the unpacked application with `npm.cmd run test:packaged`.

See [docs/harness.md](docs/harness.md) for the test map and verification policy.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Report security issues through GitHub's private vulnerability reporting flow as described in [SECURITY.md](SECURITY.md).

## License

Jasmine is licensed under the [MIT License](LICENSE).
