# Roadmap

Jasmine ships features that hold up under everyday use. Ambitious integrations that
need their own protocol work, process model, or long-running connections are built
first as standalone Pi extensions or packages, validated on their own, and only then
consumed by the desktop app through the same host-factory boundary that
[`@jasmine-ai/pi-file-changes`](../src/main/agent/extensions/fileChanges/README.md)
and the [permission gate](../src/main/agent/extensions/permissionGate/README.md)
already use.

This file records what is intentionally out of the app today and what "done" means
before it comes back in. It is a plan, not a schedule.

## Remote development over SSH

An experimental remote SSH target shipped in earlier 0.3.x builds and has since been
removed: it managed connections, rewrote the agent's read/write/edit/bash
tools to run over `ssh`, and reported file-change coverage as unsupported. That was
enough to demonstrate the idea and not enough to trust with real work, so the app no
longer carries it. Databases that stored connections drop the table on upgrade; the
hosts themselves stay in `~/.ssh/config` and are re-importable later.

A future `pi-remote-ssh` extension should target parity with VS Code Remote-SSH and
Codex remote workspaces:

- **Connection management** — import from `~/.ssh/config` including `Include`, `Match`,
  `ProxyJump`, and jump hosts; support agent forwarding, key and password auth,
  and per-host defaults without ever storing secrets in the app database.
- **One durable session per host** — connection multiplexing (`ControlMaster`)
  instead of a new `ssh` process per tool call, with keepalive, backoff, and
  transparent reconnect after sleep or network loss.
- **Remote agent process** — run the coding agent on the remote machine rather than
  proxying individual tools, so shell state, working directory, environment, and
  tool latency behave like a local run.
- **Full tool surface** — read, write, edit, bash, file search, and project scanning
  over the remote filesystem, with POSIX path canonicalization and correct handling
  of symlinks, permissions, and large files.
- **Remote file-change artifacts** — real before/after evidence from the remote
  filesystem, so the Artifacts panel reports actual coverage instead of
  "unsupported".
- **Permission scoping** — remote project roots enforced by the permission gate,
  which already models a non-local `ssh` scope with an injectable canonical path
  resolver.
- **Remote terminal** — project terminals attached to the remote host, sharing the
  connection with the agent.
- **Port forwarding** — local and remote forwards for dev servers and debuggers.
- **Honest UI** — connection state, latency, and failures visible in the composer and
  settings, and every operation cancellable.
- **Automated coverage** — an SSH server fixture in CI so connect, reconnect,
  permission, and file-change paths are exercised without a human host.

Windows/WSL and dev containers are natural follow-ons once the remote agent process
and connection layer exist.

## Chrome and browser control

Jasmine keeps an unreleased Chrome bridge and extension source in the repository, but
Settings exposes no Chrome Control page and no built-in Chrome package ships. Browser
control belongs in its own extension for the same reason SSH does: it is a separate
protocol surface with its own permission and safety model.

A future `pi-chrome` extension should cover:

- **Attach, do not hijack** — connect to an existing profile through the extension
  bridge or DevTools protocol without taking over the user's browsing session.
- **Page context tools** — readable page text, DOM queries, and bounded screenshots
  as tool results the agent can cite.
- **Action tools** — navigate, click, type, and wait, each individually approvable
  and cancellable, with a clear record of what was done.
- **Explicit trust boundaries** — page content is untrusted input; no credential or
  cookie exfiltration paths, and no silent cross-origin actions.
- **Automated coverage** — a headless fixture profile so navigation and action paths
  are tested without a human browser.

## Other candidates

- Additional coding-agent runtimes and providers behind the existing provider
  contract.
- Team or shared workspace features, which would need a storage and permission model
  beyond today's local-only SQLite projection.

## How something graduates into Jasmine

1. It exists as a standalone Pi extension or package with its own README, contract,
   and tests.
2. It is exercised in CI without a human in the loop.
3. It degrades honestly — unavailable capabilities say so instead of quietly
   producing weaker evidence.
4. Only then is it wired into the desktop app, with `docs/ui_inventory.md` and
   `docs/workflow_inventory.md` updated to record the new surface and its evidence.
</content>
</invoke>
