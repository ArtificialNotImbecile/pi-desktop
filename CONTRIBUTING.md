# Contributing to Jasmine

Thanks for contributing.

1. Open an issue for substantial behavior or architecture changes before implementation.
2. Keep renderer/main-process boundaries and IPC contracts consistent with `AGENTS.md`.
3. Add or update the smallest regression test that proves the change.
4. Run the scoped checks described in `docs/harness.md` and include the results in the pull request.
5. Do not commit credentials, local databases, generated screenshots, traces, or machine-specific paths.

Use a focused branch and keep commits limited to one coherent change. Pull requests should explain user impact, implementation boundaries, tests, and any known limitations.
