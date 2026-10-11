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

## Retomada do catálogo de mutações (#787, rodada 3)

O commit de código `8837363f7c0a95a9019ef50e45385e135196bdb0` corrige as referências deixadas pela extração. No layout anterior, `vitest run tests/workflow-service-durability.test.ts -t 'carries the OPERATOR policy, not the spec' --reporter=json` terminava com exit 0, mas com **0 testes executados e 32 ignorados** em Node 20.20.2 e 22.23.2. O catálogo continha 61 mutantes e três focos com nome ausente do arquivo declarado: `i2/spec-widens-policy`, `s/superseded-stretch-keeps-granting` e `ab/taint-frozen-before-the-leaves-run`.

Somente esses três focos passaram a declarar `tests/workflow-service-durability-cleanup.test.ts`; `scripts/mutations/slices.json`, `prova/leaf-sandbox-runtime.ts` e `prova/mutations-t15-t16.ts` agora incluem o arquivo novo sem retirar o antigo. O inventário posterior tem 61 mutantes e zero focos ausentes. O SHA-256 da serialização ordenada de `{id, mechanism, edits}` permaneceu `52733d5a868da8eb85c38ea528494db839767e6640822a15c365f58d20d05d94`; nenhum mutante, mecanismo ou edição mudou. A contagem de casos permanece 32 + 2 = 34. Os detalhes concisos estão em `r3-catalog.json`.

Em Windows 11 x64, cópias e dependências isoladas por ABI passaram `build`, `typecheck`, `lint`, `format:check` e `npm run prova -- windows-sqlite-fixture-cleanup` (34/34) em Node 20.20.2 e 22.23.2. Em Linux Node 22.23.3, no mesmo commit, `npm ci` e os cinco gates passaram: 341 arquivos, 4.506 testes aprovados e 8 ignorados com `--maxWorkers=1`. As provas `windows-sqlite-fixture-cleanup`, `leaf-sandbox-runtime` e `mutations-t15-t16` passaram com 34/34, 54/54 e 108/108. `npm run mutations:t16` matou 61/61 mutantes, sem sobreviventes e com `restoreGreen=true`; cada um dos três focos corrigidos executou um teste no baseline e um teste sob mutação, que o matou. Logs completos e relatórios JSON estão em `F:/lohra-m25-787/resume-r3/` fora do repositório, sem reutilizar os logs da rodada anterior. Essa retomada altera apenas catálogo, fatia e declarações de prova; o comportamento da fixture e do runtime medido na rodada 2 permanece byte a byte igual.

### Regressão executável da integridade do foco

O teste novo `tests/workflow-durability-focus-integrity.test.ts` seleciona os três IDs acima e exige dois focos distintos. Para cada foco, uma AST do TypeScript precisa encontrar uma chamada literal real de `it` ou `test` cujo título contenha `focus.test`; comentários e strings soltas não contam. O commit vermelho compilável `d802a97dcf9f53c2cfc83c378bf1fe27cf520599` restabeleceu temporariamente as três referências antigas: Node 20/22 executaram 1 teste e falharam com `AssertionError` causal para `i2/spec-widens-policy`. O commit verde `0d779bb3d1f705cb5a84fffe0a01239def109bda` restaurou somente as referências corretas e incluiu o teste nas provas. O texto do diagnóstico foi refinado em `83c27ffa693cf1f319d0b38dbf597290b417911f`. As duas ABIs passaram os quatro gates nativos e a prova final **35/35** (34 casos originais + 1 integridade). Contra a main `a4b03ff50c0ab6be39f28d7bf1ce8854d0e996b1`, `ci:controle-negativo` agora sai 0 com classificação `assertion-red`, porque o catálogo da base ainda aponta para o arquivo antigo. O primeiro resultado mecânico `vacuous-pass` sem o teste novo permanece preservado em `F:/lohra-m25-787/resume-r3/controle-negativo-main-a4b.log`; não foi contado como gate verde. A AST prova a declaração literal; os filtros Vitest 1/1 e a fatia `t16` documentada acima complementam a evidência de execução real. Os bytes do catálogo e das edições de mutantes no commit final de código são idênticos ao commit `8837363` que passou `t16`.

No commit final de código `83c27ffa693cf1f319d0b38dbf597290b417911f`, Linux Node 22.23.3 passou novamente `build`, `typecheck`, `lint`, `format:check` e `npm test -- --maxWorkers=1`: 342 arquivos, 4.507 testes aprovados e 8 ignorados. As três provas relacionadas passaram com 35/35, 54/54 e 109/109, respectivamente. O arquivo novo explica exatamente um caso e um arquivo adicionais em relação ao primeiro full da rodada 3. O catálogo/fatia permanecem byte a byte iguais ao commit do `mutations:t16` 61/61; a fatia não foi repetida após a alteração exclusiva do teste de integridade e das declarações de prova. Os logs finais estão em `F:/lohra-m25-787/resume-r3/linux/final-*`.
