# Pi Permission Gate

`@jasmine-ai/pi-permission-gate` is a fail-closed Pi coding-agent extension for
interactive approval of shell commands and file mutations. It works as a
standalone Pi package and exposes an injectable factory for Jasmine.

## Policy

- `ask` (default): every `bash` call requires one-time approval.
- `ask`: `write` and `edit` run without a prompt only when a trusted project
  root exists and both lexical and canonical path checks keep the target inside
  it.
- `ask`: when no trusted project exists, every `write` and `edit` call requires
  approval.
- `full-access`: the gate does not intercept `bash`, `write`, or `edit`.
- `read` and other non-mutating Pi tools are outside this package's policy.
- Missing UI, invalid configuration, canonicalization errors, callback errors,
  cancellation, malformed inputs, and invalid approval decisions fail closed.

An approval is for one tool call only. It is not a persistent allow rule.

## Pi CLI

Build the package, then load the default extension entrypoint:

```sh
npm run build
pi -e ./dist/index.js --permission-mode ask
```

To preserve Pi's unrestricted behavior explicitly:

```sh
pi -e ./dist/index.js --permission-mode full-access
```

The default CLI integration uses Pi's `ctx.ui.select`. In print/JSON modes (or
any mode without dialog-capable UI), an approval-required call is blocked
immediately instead of waiting for input that cannot arrive.

## Jasmine / SDK host

Use the named factory and provide host-owned state and approval UI:

```ts
import { createJasminePermissionGateExtension } from "@jasmine-ai/pi-permission-gate";

const extension = createJasminePermissionGateExtension({
  getMode: () => settings.permissionMode,
  getScope: () => currentTarget.kind === "ssh"
    ? {
        projectRoot: currentTarget.projectRoot,
        cwd: currentTarget.remoteCwd,
        pathFlavor: "posix",
        target: "ssh",
        label: currentTarget.host
      }
    : {
        projectRoot: currentProject?.root ?? null,
        cwd: runtimeCwd,
        pathFlavor: "native",
        target: "local"
      },
  requestApproval: (request, signal) => approvalBroker.request(request, signal),
  canonicalizePath: (request) => filesystemBroker.realpath(request)
});
```

`projectRoot` is a security boundary and must come from trusted host state, not
from an LLM message or tool input. Jasmine must pass `null` for chats without a
project even if the runtime internally uses a scratch directory.

Native local scopes use the package's nearest-existing-ancestor `realpath`
resolver by default. POSIX/SSH scopes must inject a canonical resolver backed by
the remote filesystem. Without one, inside-project writes still require
approval because symlink containment cannot be proven.

Approval UIs should render `request.summary`, which escapes terminal control,
C0/C1, newline, and bidirectional override characters and caps display length.
The raw `command` and `path` fields are supplied only for policy/audit logic and
must not be rendered without equivalent sanitization.

## Security boundary

This extension is a policy gate, not an OS sandbox:

- An approved shell command can read, modify, or execute anything allowed to
  the Pi process.
- File paths can change after canonicalization (TOCTOU). Strong containment
  requires enforcement in the actual filesystem operation or an OS sandbox.
- Pi extensions loaded after this gate can mutate tool inputs or execute work
  through their own APIs. SDK hosts should register this factory last and audit
  other extensions.
- Custom tools are not automatically classified as mutations. Hosts must gate
  them separately or keep them disabled until assigned an explicit policy.

## Development

```sh
npm run check
```

The check performs strict TypeScript typechecking, a clean build, and the
package's Node unit suite.
