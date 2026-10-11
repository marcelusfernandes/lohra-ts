# SQLite fixture cleanup — Windows 11 x64

Issue #787; base `af37215ef886673a3967fe41ab0e1fe3504f83a9`, candidate code `d8d40c2546dfde4dd2267f367c8cfae8d4d8f026`.

`probe.mjs` is the source of the controlled probe. It accepts only a disposable clone containing `.lohra-disposable-probe`, changes one existing assertion in that clone, then runs the corresponding Vitest case with its own TEMP/TMP. No source in the PR worktree is deliberately broken. Example invocation after `npm ci` in a marked clone:

```text
node docs/investigations/windows/evidence/sqlite-fixture-cleanup/probe.mjs <disposable-clone> policy <isolated-evidence-dir>
node docs/investigations/windows/evidence/sqlite-fixture-cleanup/probe.mjs <disposable-clone> acquisition <isolated-evidence-dir>
```

Each command exits **1 by design**: the original assertion must remain a failure. The probe captures the child's exit, whether the assertion is reported, whether `EBUSY` obscures it, and whether the fixture root or `state.db` remains. Logs replace clone and TEMP paths with `<CLONE>` and `<TEMP>`; trailing blank lines were normalized for Git. Node 20 and 22 used separate clones and dependency installs; no provider or user home was read.

| Node    | Fixture         | Base: assertion / EBUSY / state.db left | Candidate: assertion / EBUSY / state.db left |
| ------- | --------------- | --------------------------------------- | -------------------------------------------- |
| 20.20.2 | operator policy | no / yes / yes                          | yes / no / no                                |
| 20.20.2 | acquisition     | no / yes / yes                          | yes / no / no                                |
| 22.23.2 | operator policy | no / yes / yes                          | yes / no / no                                |
| 22.23.2 | acquisition     | no / yes / yes                          | yes / no / no                                |

All eight probe subprocesses exited 1. The base logs show `EBUSY` at the fixture's `rmSync` and again in `afterEach`; candidate logs show the intentional assertion failure without a secondary cleanup error. Their JSON reports and sanitized logs are adjacent to this note. A remaining fixture root count of zero after the candidate run means `state.db` was removed before process exit; no retry or skip was used.
