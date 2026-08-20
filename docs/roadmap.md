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

The earlier 0.3.x tool-proxy experiment remains removed. It rewrote individual
read/write/edit/bash operations over SSH while the agent and session stayed local,
which could not provide correct shell state, complete tool coverage, or trustworthy
remote artifacts.

The standalone [`@jasmine-ai/pi-remote`](../src/main/agent/extensions/piRemote/README.md)
package now owns the CLI-first replacement. It uploads a hash-verified, versioned Pi
runtime to a profile-private remote root, keeps remote Pi config and JSONL sessions
separate from the remote user's normal `~/.pi`, and exposes both the native Pi TUI
and a persistent headless RPC port. The remote host needs Linux x64/glibc 2.27,
OpenSSH, `sh`, `tar`, `sha256sum`, and a writable home, but does not need Pi, Node, npm, or public
Internet access.

The CLI can explicitly synchronize local `models.json` and portable model defaults,
imports credentials one provider at a time, and atomically activates a newly bundled
content-addressed runtime on the next connection without moving profile sessions or
configuration into the runtime directory.

The package also implements explicit `client-proxy` egress through an authenticated
HTTP forward/CONNECT gateway and OpenSSH reverse forwarding. It is fail-closed for
private/client-LAN destinations and is deliberately not described as transparent
networking: UDP, arbitrary direct sockets, containers, background services, and
sudo policy remain outside the v1 contract.

The next desktop phase is intentionally still out of scope here. Jasmine main must
consume the package's `RemoteRuntimeManager`/`RemoteSessionPort` factory, bind a chat
to one remote profile/session, project remote file-change evidence and permission
scope, connect project terminals, and expose connection/egress state honestly. That
work begins only after the standalone package's Windows-to-Linux live matrix is
green. The experimental upstream Pi client/protocol/server remains an exact-pinned
compatibility target until it supplies a complete coding-agent service, extension
UI, authentication, bootstrap, and capability negotiation.

Windows/ARM64/musl remote hosts, dev containers, and cloud/mobile relays remain
follow-ons rather than implicit promises.

## Chrome and browser control

An unreleased Chrome takeover bridge, its native-messaging host, and a bundled
extension lived in the repository without any way to switch them on: no Settings
page ever called them. They have been removed, and the `chrome_takeover_*` columns
are dropped on upgrade. Browser control belongs in its own extension for the same
reason SSH does: it is a separate protocol surface with its own permission and
safety model.

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

## MCP servers

Settings once listed a marketplace and let servers be installed, enabled, and
removed, but nothing ever started a server or handed its tools to the agent — the
records only sat in SQLite. Pi ships no MCP support of its own — its README states
"No MCP" and points at extensions for anyone who wants it — so a half-wired panel
promised a capability the app could not deliver. The UI, IPC, marketplace, and
`mcp_servers` table are gone.

Bringing MCP back means a real client, not a settings page:

- **Live sessions** — stdio and HTTP transports with process lifecycle, restarts,
  and cancellation owned by Electron main.
- **Tools in the turn** — discovered tools registered as pi custom tools through the
  same path the agent already uses, so they appear in timelines and traces.
- **Permission parity** — MCP tool calls pass the permission gate like bash and file
  writes do, with the server identified in the prompt.
- **Honest status** — connection state, handshake failures, and tool-count drift
  visible in Settings instead of a stored boolean.

## Web access

Jasmine used to run its own DuckDuckGo and Bing HTML scraping as a fallback search
provider, prefetching results and injecting them into every request. Scraped result
pages are brittle and the prefetch spent a request whether or not the turn needed
one.

It also gave the same capability two homes: a Web Search settings page with its own
table, and an ordinary Packages row for
[`pi-web-access`](https://github.com/nicobailon/pi-web-access). One boolean in two
places produced the whole class of defect that follows from it -- a save that did
not reach the package, a package switch reverted on the next send, a page showing
state it no longer had. Every one of them was a seam between the two copies rather
than anything wrong with the package.

Web access is now that package and nothing else. It is enabled from Packages like
any other, pi decides when to call `web_search`, `fetch_content`, and friends, and
`web_search_settings` is dropped on upgrade. Jasmine keeps no web setting, runs no
search, and traces none under its own name; results still surface on assistant
messages, derived from what the package records.

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
