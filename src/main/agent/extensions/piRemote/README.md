# `@jasmine-ai/pi-remote`

Managed, isolated Pi runtimes over the system OpenSSH client. The remote host does
not need Pi, Node.js, npm, GitHub access, or package-registry access. The package
ships one hash-verified Linux x64 runtime artifact and uploads it through SSH when
the selected version is missing.

This package has two deliberately separate paths:

- `pi-remote connect` attaches the native Pi fullscreen TUI on the remote host.
- the exported `RemoteSessionPort` uses persistent Pi RPC for future desktop and
  other headless clients.

The ordinary Pi package entrypoint is only a thin handoff and diagnostic bridge.
It never replaces Pi's tools or local `SessionManager`.

## Supported baseline

- client: Windows, macOS, or Linux with a system `ssh` executable;
- authentication: `IdentityFile`, ssh-agent, `ProxyJump`, and other OpenSSH config;
- remote: Linux x64, glibc 2.27 or later, POSIX `sh`, `tar`, `sha256sum`, and a writable home;
- managed Pi: exactly `0.84.2` for runtime release `0.1.1`.

The runtime uses an official Bun-compiled Pi release plus a Bun-compiled host;
the target does not execute a system Node binary. `fd`, `rg`, tmux, required
non-glibc tmux libraries, licenses, and manifests are included.

## Development install

```powershell
npm.cmd --prefix src/main/agent/extensions/piRemote install --ignore-scripts
npm.cmd --prefix src/main/agent/extensions/piRemote run build
node src/main/agent/extensions/piRemote/dist/cli.js help
```

Once published, install the CLI using npm and optionally install the Pi extension:

```powershell
npm.cmd install -g @jasmine-ai/pi-remote
pi install npm:@jasmine-ai/pi-remote
```

`pi install` keeps package binaries in Pi's private package root, so it does not
replace the global npm install. Inside Pi, `/remote`, `/remote-doctor`, and
`/remote-profiles` call the same package core. Quote or backslash-escape a cwd
that contains spaces, for example `/remote ops-box --cwd "/srv/my project"`.

## Profiles and first connection

```powershell
pi-remote profile add ops-box `
  --host ops-box `
  --cwd /srv/application

pi-remote doctor ops-box
pi-remote connect ops-box
```

Use `--port` when it is not already in SSH config. Host and cwd are separate
arguments; `host:path` is intentionally unsupported.

Profiles have a stable random UUID. Remote state is isolated under:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/pi-remote/
  runtimes/<artifact-sha>/
  profiles/<profile-uuid>/agent/
  profiles/<profile-uuid>/sessions/
  profiles/<profile-uuid>/logs/
```

The runtime sets `PI_CODING_AGENT_DIR` and
`PI_CODING_AGENT_SESSION_DIR`; it does not change `HOME` or access the remote
user's normal `~/.pi/agent`. Project-owned files such as `AGENTS.md` and `.pi`
settings remain visible because they belong to the selected remote project.

## CLI

```text
pi-remote profile add|list|show|remove
pi-remote doctor <profile> [--json]
pi-remote connect <profile> [--cwd PATH] [--continue|--resume|--session ID]
pi-remote prompt <profile> --text TEXT [--image FILE] [--json]
pi-remote shell <profile> -- <command>
pi-remote sessions list <profile>
pi-remote runtime status|install|upgrade <profile>
pi-remote auth list|import|remove <profile> --provider ID
pi-remote config sync <profile> [--from-agent-dir PATH] [--yes]
pi-remote file put|get ...
pi-remote stop <profile>
```

`profile remove` deletes local connection metadata only. It never deletes remote
sessions or credentials. File transfers are single regular files, atomic on put,
and limited to 64 MiB.

Every command that needs the managed runtime checks the package artifact hash.
A missing artifact is uploaded and verified offline; an already installed target
is atomically selected through the `current` symlink. Failed installs keep the
previous runtime, while profile configuration and sessions remain outside every
content-addressed runtime directory.

## Disconnect semantics

- Exiting the remote Pi TUI normally, `pi-remote stop`, or a graceful headless
  close with abort ends the active turn.
- SSH EOF, network loss, or a crashed client detaches only. The remote TUI or RPC
  child remains owned by the profile daemon and can be reattached.
- Client-proxy profiles retain a mode-`0600` profile egress lease containing the
  reverse-forward port and random proxy token. A restarted client retrieves that
  lease through SSH, so the surviving child keeps the same proxy environment;
  `pi-remote stop` removes the lease and rotates it on the next connection.
- RPC events carry monotonic sequence numbers and use a bounded in-memory replay
  ring. Authoritative Pi state/session entries repair a replay gap.
- A prompt or tool action is never automatically replayed after uncertainty.

The host daemon listens on a profile-private Unix socket only. It has no TCP or
public listener and exits after 15 idle minutes when it owns no child session.

## Client proxy egress

New profiles default to `remote-direct`. Enable the connecting machine as an
HTTP(S) exit explicitly:

```powershell
pi-remote profile add isolated-box `
  --host isolated-box `
  --cwd /srv/application `
  --network client-proxy
```

`client-proxy` starts an authenticated local HTTP forward/CONNECT gateway and a
dedicated OpenSSH reverse forward. The gateway:

- listens only on local `127.0.0.1`;
- allows public destinations on ports 80 and 443 by default;
- rejects loopback, private, link-local, CGNAT, metadata, multicast,
  documentation, and IPv6 ULA/link-local destinations;
- validates every resolved address to prevent DNS rebinding;
- does not terminate TLS;
- records only host, resolved address, port, decision, byte counts, duration, and
  error code in a bounded local audit log.

Proxy credentials travel in an SSH-encrypted run descriptor and child environment,
never in command arguments. The gateway does not proxy the connecting machine's
LAN or VPN. Exact remote-private hosts can be listed in profile `NO_PROXY` data so
the remote process connects to them directly.

An upstream local HTTP(S) proxy can be selected by environment-variable name with
`--upstream-proxy-env`. The upstream URL and credential remain on the client.

This is not transparent networking. UDP, raw DNS, ICMP, git-over-SSH, arbitrary
direct sockets, containers, systemd/cron, and sudo environment policy are outside
the v1 guarantee. If SSH forwarding is disabled, the command returns a structured
`remote-forwarding-disabled` error and does not bypass sshd policy.

For apt, use `pi-remote-net apt <apt-get arguments>`. The helper writes the proxy
URL to a mode-`0600` temporary apt config, explicitly loads it with `apt-get -c`,
passes only that file path across sudo, and removes it after apt exits; the proxy
credential never appears in the apt or sudo command line.

## Local model configuration

Copy local custom providers and portable model defaults into one isolated remote
profile without copying Windows package/skill paths or UI preferences:

```powershell
pi-remote config sync ops-box --yes
```

The command transfers `models.json` plus `defaultProvider`, `defaultModel`, and
`defaultThinkingLevel` from local `settings.json`. It uses SSH stdin, does not
store the payload in the local profile database, and writes only the selected
profile's agent directory. Those three defaults are source-synchronized: a later
sync removes a remote default that is no longer present locally while preserving
unrelated remote settings. Provider credentials remain a separate explicit
`auth import --provider` operation.

## Credentials

Remote Pi credentials live only in the selected profile. Authenticate normally in
the remote TUI or copy one explicitly selected local provider:

```powershell
pi-remote auth import ops-box --provider openai --yes
pi-remote auth list ops-box
pi-remote auth remove ops-box --provider openai
```

Import reads one provider entry from the local Pi `auth.json`, transfers it through
SSH stdin, writes the remote profile file with mode `0600`, and never displays the
credential value. Use `--from-agent-dir` for a non-default local Pi agent directory.

## Public API

The package exports:

- `ManagedRemoteRuntime` / `RemoteRuntimeManager`;
- `RemoteSessionPort` and normalized event/session types;
- `EgressBroker`, `ClientGateway`, and `ProxyAuditLog`;
- `ProfileStore`, `SshRunner`, framing helpers, and `PiRemoteError`.

The public API does not expose experimental `@earendil-works/pi-protocol` DTOs.
Exact `0.84.2` upstream client/protocol/server packages are development-only
compatibility targets. `UPSTREAM_PI_REMOTE_BASELINE` records the currently missing
capabilities before that adapter can replace Pi RPC.

## Verification

The Linux x64 runtime archive is intentionally not committed to Git: every
rebuild produces a new ~83 MB tarball and git stores each version forever.
Instead, `artifact.json` pins the archive SHA-256 and an HTTPS download URL,
`npm run runtime:fetch` downloads and verifies it (run automatically by the
root `postinstall`), and `npm run runtime:build:linux-x64` rebuilds it locally
from pinned upstream sources when the descriptor is updated.
Before publishing, the builder runs `readelf --version-info` over tmux and every
bundled shared library and rejects any required GLIBC symbol version newer than
the declared 2.27 baseline, including nonnumeric ABI tags that cannot be ordered
safely. Both native Linux and WSL builders must report `uname -m` as `x86_64`.
The Windows build path defaults to the pinned `Ubuntu-18.04` WSL distribution,
but these checks also guard direct Linux builds.

```powershell
npm.cmd run check
npm.cmd run runtime:fetch
npm.cmd run runtime:verify
npm.cmd pack --dry-run --json
```

The live test harness additionally requires an explicitly provided disposable SSH
profile. It tests first-connect offline install, old-to-new artifact activation,
local model/credential import, raw Pi request-context parity, native TUI and
session resume, repeated disconnects without prompt replay, persisted stop reasons,
Linux-only execution and a client-visible Python service, direct/client-proxy LLM
requests, direct and audited client-proxy pip/npm/apt paths, forwarding reconnect,
private-target denial, file-transfer integrity, redaction, and native Pi isolation.

`npm run test:upgrade-live` runs the runtime auto-upgrade acceptance against a
disposable SSH profile: it installs the current artifact, installs a *previous*
artifact from `PI_REMOTE_E2E_PREVIOUS_ARTIFACT_DIR` (a directory holding that
version's `artifact.json` and archive), then verifies the next connection with
the current package automatically switches the remote `current` runtime back,
preserves the synced profile model configuration, and that the old runtime
generation can be removed afterwards. Because tarballs are no longer committed to
Git, build the previous artifact directory by re-compressing the same runtime
content (for example `gzip -9n`) so the inner `SHA256SUMS` still verifies while the
archive hash differs.

No code from the reverse-engineered Codex desktop sources is copied into this
package. They were used only to identify behavioral boundaries.
