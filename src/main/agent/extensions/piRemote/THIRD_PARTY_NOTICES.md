# Third-party notices

The source package is MIT licensed. Its bundled Linux runtime contains these
separately distributed components:

| Component | Version | License | Provenance |
| --- | ---: | --- | --- |
| Pi coding agent | 0.84.2 | MIT | Unmodified official `pi-linux-x64.tar.gz`; upstream SHA-256 `906fbe787fd225c4ac624fe7ebd5b1d55a60e0f5c7ef51795d231564f9ee1c13` |
| Bun runtime used to compile `pi-remote-host` | 1.3.14 | MIT | `bun build --compile --target=bun-linux-x64-baseline` |
| tmux | 2.6 build baseline | ISC and package notices | Binary and exact non-glibc runtime libraries copied by the artifact builder; package copyright files are embedded under `licenses/` |
| fd | 10.4.2 | Apache-2.0 OR MIT | Official x86_64 musl archive; pinned SHA-256 `e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde` |
| ripgrep | 15.2.0 | Unlicense OR MIT | Official x86_64 musl archive; official SHA-256 `33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c` |

The runtime artifact includes the complete Pi release notices and the exact
copyright/license files for bundled tmux libraries, fd, and ripgrep. The artifact
manifest hashes every bundled file. `scripts/build-runtime.mjs` records source
versions and verifies pinned release hashes before packaging.
