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

## Revisão após o contrato de tamanho

A revisão extraiu somente os dois casos afetados para `tests/workflow-service-durability-cleanup.test.ts` e o helper compartilhado para `tests/workflow-service-durability.fixture.ts` no commit `292693484e3325bb8a3d8fba17d38f81b56f9537`. A prova declara agora o arquivo legado e o novo: 32 + 2 = 34 testes. O arquivo legado caiu de 2.336 linhas na base para 2.058, respeitando a regra de não crescimento para arquivos preexistentes acima de 800 linhas.

`probe.mjs` escolhe o novo arquivo quando presente e mantém o arquivo original como fallback para reproduzir o vermelho na base. As quatro sondas `r2-green-*` foram executadas em clones descartáveis separados com Node 20.20.2 e 22.23.2. Cada subprocesso saiu com código 1 pela asserção proposital (`assertionSeen: true`), sem `EBUSY` e sem diretório ou `state.db` residual. Os logs da rodada anterior permanecem como evidência histórica do vermelho/verde antes da extração; a rodada 2 mede o layout final.
