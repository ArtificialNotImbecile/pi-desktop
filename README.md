# Jasmine

### The desktop app for Pi

Jasmine is an independent, open-source desktop GUI for the Pi coding agent, bringing Pi-compatible sessions, terminal workflows, skills, extensions, and agent interactions into a modern desktop app.

> Jasmine is a community-built project and is not affiliated with or endorsed by Pi.

![Jasmine main workspace](docs/assets/screenshots/main.png)

## Features

- **Pi Sessions** — keep Pi-compatible JSONL as the canonical conversation record, with persistent local threads, drafts, projects, search, and session import.
- **Desktop GUI for Pi** — use rich chat, attachments, Working tasks, memories, activity, and project context without leaving the desktop app.
- **Pi Skills & Extensions** — work with reusable skills, prompt templates, Pi packages, MCP servers, and web access.
- **Integrated Terminal** — run project terminals and remote shells alongside coding-agent conversations.
- **Fast file-change artifacts** — inspect managed `write/edit` targets with unified text diffs and before/after image snapshots, or opt into an event-based filesystem watcher for broader shell visibility without crawling the workspace.
- **Flexible models** — connect multiple OpenAI-compatible providers with model discovery and per-model options.

Jasmine stores application data locally, but configured AI providers, web search tools, MCP servers, remote hosts, and browser automation can send data outside the computer. Review each integration before enabling it.

Pi-compatible JSONL is the canonical model conversation record. SQLite remains the transactional projection for thread lists, search, UI paging, settings, traces, and links back to JSONL entry IDs. See [session storage](docs/session_storage.md) and [Pi session import](docs/pi_session_import.md).

## Context inspection

Jasmine exposes each model request as a readable context taxonomy. The latest user task appears as soon as it is persisted and shows every provider subrequest (`1/N`) in wire order, with text, reasoning, tool calls/results, provider options, explicit unclassified fields, payload shape, actual usage, estimated composition, and DeepSeek/Kimi reasoning-retention validation. Sanitized raw payloads are gzip-backed and loaded only when expanded.

![Inspecting a real DeepSeek request in Context Taxonomy](docs/assets/context-taxonomy.gif)

The example above uses two real model turns and opens the captured conversation context and provider request. See [reasoning context retention](docs/reasoning_context_retention.md) for the provider-specific DeepSeek and Kimi rules that determine which historical thinking blocks must be replayed.

## File change artifacts

Jasmine consumes the standalone [`@jasmine-ai/pi-file-changes`](src/main/agent/extensions/fileChanges/README.md) package through its host factory. The default `managed-tools-only` mode captures only exact approved `write/edit` targets and never walks the project, so unrelated large files cannot delay chat. The optional watcher mode observes native filesystem events for broader Bash visibility, but clearly reports that before content and causal attribution are not guaranteed. Neither mode parses shell commands or guesses renames.

The Artifacts panel stores each capture as a run-level observation ledger and lazily opens GitHub-style unified text diffs or bounded before/after image snapshots when those revisions are available. Editing or retrying conversation messages does not erase earlier captures because it also does not roll back the filesystem. Files selected by sensitive-path or high-confidence-content rules retain their path, status, hash, size, and mode, while preview bytes and diffs are redacted. Failed runs keep any evidence already captured. Remote SSH tracking is reported as unsupported instead of treating local paths as remote evidence.

## Product tour

<details>
<summary>Workspace, local context, and project tools</summary>

| Working | Search |
| --- | --- |
| ![Working task center](docs/assets/screenshots/working.png) | ![Search chats](docs/assets/screenshots/search.png) |
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
| Skills | Packages |
| ![Skill settings](docs/assets/screenshots/settings-skills.png) | ![Package settings](docs/assets/screenshots/settings-packages.png) |
| Prompt Templates | Remote |
| ![Prompt template settings](docs/assets/screenshots/settings-prompt-templates.png) | ![Remote settings](docs/assets/screenshots/settings-remote.png) |
| MCP Servers | Activity |
| ![MCP server settings](docs/assets/screenshots/settings-mcp.png) | ![Activity settings](docs/assets/screenshots/settings-activity.png) |
| Web Search | About |
| ![Web Search settings](docs/assets/screenshots/settings-web-search.png) | ![About Jasmine](docs/assets/screenshots/settings-about.png) |

</details>

## Install

Download the appropriate asset from [GitHub Releases](https://github.com/ArtificialNotImbecile/pi-desktop/releases/latest) and verify it against the published `SHA256SUMS.txt`.

- **Windows x64:** use `Jasmine-Setup-<version>-x64.exe`. The installer is not code-signed, so Windows may show a SmartScreen warning. The in-app updater currently supports Windows releases.
- **Linux x64:** use `Jasmine-<version>-linux-x86_64.AppImage` for a portable launch or `Jasmine-<version>-linux-amd64.deb` on Debian-based distributions. The AppImage may need `chmod +x` before its first launch.
- **Apple Silicon macOS:** use `Jasmine-<version>-mac-arm64.dmg`.

The macOS builds use ad-hoc signing and are not notarized. Trusted users may need to try opening Jasmine once, then choose **System Settings → Privacy & Security → Open Anyway**. Managed Macs may prohibit this override.

## Requirements for local development

- Node.js 22
- npm

## Run locally

```powershell
git clone https://github.com/ArtificialNotImbecile/pi-desktop.git
cd pi-desktop
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

The unreleased Chrome bridge and extension source remain in the repository for future package work, but Jasmine does not currently expose Chrome Control in Settings or ship a built-in Chrome package.

## Testing

Common checks:

```powershell
npm.cmd run build
npm.cmd run test:unit
npm.cmd run harness:check
npm.cmd run test:e2e:smoke
```

Run `npm.cmd run test:e2e` for the full Electron suite in background/off-screen mode. It keeps test windows transparent, non-focusable, and out of the taskbar; use `npm.cmd run test:e2e:headed` only for intentional foreground debugging. Run `npm.cmd run harness:release` for the complete local release gate; its final acceptance stage is intentionally headed. Generated screenshots, traces, audits, and acceptance results are written under ignored `test-results/` paths.

Regenerate the README screenshots and real-model taxonomy GIF with `npm.cmd run readme:capture`. This command uses `DEEPSEEK_API_KEY` for two live requests. Build the Windows installer with `npm.cmd run dist:win` and validate the unpacked application with `npm.cmd run test:packaged`. Linux and macOS packages are built and smoke-tested on their native GitHub Actions runners during a release.

See [docs/harness.md](docs/harness.md) for the test map and verification policy.

## Documentation

Start with the [Jasmine documentation](docs/README.md) for Pi session behavior, storage, reasoning context, and desktop development workflows. Maintainers should read the [development and release guide](docs/development-and-release.md) before publishing a version.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Report security issues through GitHub's private vulnerability reporting flow as described in [SECURITY.md](SECURITY.md).

## License

Jasmine is licensed under the [MIT License](LICENSE).
