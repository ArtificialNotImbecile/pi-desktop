# Current UI Issue Register

Record only currently reproducible defects. Remove a row after its regression passes; durable prevention belongs in tests and `AGENTS.md`, not a historical fix log.

| ID | Status | Severity | Source | Affected | Reproduction | Regression |
| --- | --- | --- | --- | --- | --- | --- |
| UI-101 | Open | Low | Measured against `4a01e82` while landing the run-header rework | Streaming settle time for long assistant output | Send `return long answer smooth stream scroll intent provenance reading lock` and time from first live frame to the block leaving `.live-message` with its final paragraph rendered: ~9.9s on this branch vs ~8.9s at `4a01e82` (n=3 each, ±10ms). Deterministic, not flaky. | None yet — `tests/e2e/panels.spec.ts` only caught it by sitting on the default 10s budget, and that budget is now aligned to its siblings. A regression needs a real settle-time assertion, which requires a stable timing baseline this suite does not yet have. |
