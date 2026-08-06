# Jasmine

Jasmine (**Just Another Self Mine**) is a local-first desktop workspace for AI-assisted chat, projects, tools, and personal context. The application is built with Electron, React, TypeScript, and SQLite.

## Features

- Persistent local threads, messages, drafts, projects, TODOs, memories, and activity records.
- Multiple OpenAI-compatible providers with model discovery and per-model options.
- Rich chat rendering, attachments, prompt templates, skills, plugins, MCP servers, remote shells, and local project context.
- Optional Chrome integration for user-directed browser automation.
- English and Chinese interface copy, appearance settings, Spotlight launcher, and a structured UI test harness.

Jasmine stores application data locally, but configured AI providers, web search tools, MCP servers, remote hosts, and browser automation can send data outside the computer. Review each integration before enabling it.

## Requirements

- Windows 10 or later
- Node.js 22
- npm

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

Run `npm.cmd run test:e2e` for the full Electron suite and `npm.cmd run harness:release` for the complete local release gate. Generated screenshots, traces, audits, and acceptance results are written under ignored `test-results/` paths.

See [docs/harness.md](docs/harness.md) for the test map and verification policy.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Report security issues through GitHub's private vulnerability reporting flow as described in [SECURITY.md](SECURITY.md).

## License

Jasmine is licensed under the [MIT License](LICENSE).
