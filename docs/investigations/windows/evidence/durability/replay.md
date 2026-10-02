# Reexecução e recortes da W5

As execuções originais ocorreram em clones descartáveis da árvore `fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1`, um por ABI (`npm ci` separado para Node 20.20.2 e 22.23.3). O clone Windows usou `git -c core.protectNTFS=false clone` por causa de `aux.ts` na árvore; isso não é uma afirmação de suporte. Os scripts locais `.mjs` ficaram em `%TEMP%\lohra-w705-agent`, fora do checkout; sua fonte integral, com apenas o prefixo do caminho pessoal substituído, está em [probe-source.md](probe-source.md). Os JSONs adjacentes guardam resultados compactos; logs brutos permaneceram só em temporário e seus SHA-256 constam nos JSONs. Não contêm banco, token ou dump de ambiente pessoal.

Para repetir o **corpus**, em PowerShell, a partir de cada clone com sua versão de Node e `npm ci` concluído:

```powershell
$env:HOME = Join-Path $env:TEMP 'w5-profile'
$env:USERPROFILE = $env:HOME
$env:LOHRA_HOME = Join-Path $env:HOME 'lohra'
$env:CODEX_HOME = Join-Path $env:HOME 'codex'
$env:npm_config_cache = Join-Path $env:HOME 'npm-cache'
$env:npm_config_prefix = Join-Path $env:HOME 'npm-prefix'
& $nodeExe node_modules/vitest/vitest.mjs run tests/workflow-cross-process.test.ts tests/workflow-durability.test.ts tests/workflow-shutdown.test.ts tests/workflow-service-durability.test.ts tests/state-locks.test.ts tests/workflow-steer-tool.test.ts tests/orchestration-child-runner-abort.test.ts --maxWorkers=2
```

`$nodeExe` foi o `node.exe` portátil da respectiva versão; o diretório de trabalho foi o clone descartável correspondente. O runner de origem também definiu `TEMP`/`TMP` e `LOHRA_HOME`/`CODEX_HOME` sob o mesmo perfil temporário, capturou stdout/stderr separados, fixou teto de 180 s e matou apenas sua árvore filha no timeout. Exit 1 em ambas as versões, sem timeout. Recorte dos dois erros (idênticos nas versões):

```text
FAIL tests/workflow-service-durability.test.ts > workflow service — leaf capability sandbox > the leaf dispatch of a launched run carries the OPERATOR policy, not the spec
Error: EBUSY: resource busy or locked, unlink '<TEMP>\state.db'
tests/workflow-service-durability.test.ts:1460:7  rmSync(root, { recursive: true, force: true })

FAIL tests/workflow-service-durability.test.ts > workflow service — leaf capability sandbox > installs one sandbox per ACQUISITION and disposes only its own
Error: EBUSY: resource busy or locked, unlink '<TEMP>\state.db'
tests/workflow-service-durability.test.ts:2193:7  rmSync(root, { recursive: true, force: true })
```

Para a **sonda de lease/fence**, em cada ABI foram criados processos `node.exe --import <clone>/node_modules/tsx/dist/loader.mjs <TEMP>/lease-worker.mjs <clone> <TEMP>/state.db <mode> native-lease-probe`. O worker abriu `openStateDatabase`, `LockRepository` e `WorkflowRepository`. A (`hold`) chamou `acquireRunLease(runId,'procA',1000,900)` e `putRunState` com fence 1, então aguardou stdin. B (`busy`) tentou `acquireRunLease(...,'procB',1001,900)` e recebeu `null`. Outro B (`takeover`) chamou em `1901`, recebeu fence 2 e gravou `complete`. A recebeu `stale` no stdin, tentou `putRunState(...,fence=1,holder='procA',now=1901)` e `releaseRunLeaseAtFence(...,fence=1)`. Ambas retornaram `false`; a leitura final mostrou `complete/procB`. Todos os filhos saíram com código 0. O orquestrador tinha deadline por processo e `taskkill /PID <pid> /T /F` apenas em seu próprio filho ainda vivo. SHA-256 do worker temporário: `1e81e9a0efb00dd825e7a575bf2c6f184cd73bfadb9ae8aea21853ecc23f094c`.

Para **crash/resume**, A iniciou `tests/workers/workflow-launch-worker.ts <db> <home-a> 1000` por `node.exe --import <tsx-loader>` e aguardou `READY`/`RUN_ID`. Um segundo processo abriu a base e leu `getRunState`, `listNodeCache`, `getRunSpend` e eventos de auditoria. O pai encerrou A com `child.kill('SIGKILL')` e aguardou o evento `close`, depois repetiu a leitura em novo processo. C criou uma nova conexão e `WorkflowService` com `AuditTrail`, executou `resume(runId)` com relógio injetado `1901`, e um último leitor verificou o estado. Em Node 20/22: `running/first` antes e após o kill; `complete/first,second` depois; `spawnCounts['produce-second']=1`; eventos `segment.completed` interrompido, `audit.gap` (`process_crash`), `cache.replayed`, `workflow.done`; todos os leitores e C saíram com código 0. O filho A terminou com `signal='SIGKILL'`. Os scripts temporários `read-run.mjs` e `resume-audited.mjs` tiveram SHA-256 `2c52165bf991fa76ec34ad9ded7237eee3792c146cca3e491eb7c9c75b569d6f` e `5857c5bf22c1c42e4710089ad77499373f01a960a1e7ca0ca945aacba1f56d75`.

Para **supervisão**, cada modo (`cancel`, `steer`, `shutdown`) usou um filho `node.exe --import <tsx-loader> <TEMP>/supervision-worker.mjs <clone> <db> <home> <mode>` em SQLite e home separados. Um `ChildRunner` stub ficou bloqueado após sinalizar pronto; após um `setImmediate` para registrar a folha ativa, o worker invocou respectivamente `service.cancel(runId)`, `core.steer(subId,'operator redirect')` ou `service.shutdown('signal')`. O stub resolveu com `usage={tokensIn:3,tokensOut:1}`, `usageUncertain=true`, `partial=true`; as sondas consultaram estado, spend e auditoria após o retorno. `steer` drenou um lembrete `<system-reminder>`; cancel/shutdown resultaram `cancelled`, steer `complete`; exit 0, gasto `3/1`, `partial_leaves=1` e nenhuma imagem de PID residual em `tasklist /FI "PID eq <pid>"` em ambos os Nodes. O worker temporário teve SHA-256 `734a23452a4f3d7d887dc77b2c99b832e8fe2a94f6eb12bc26676a7ba5a903c4`.

Para repetir as sondas, extraia os blocos completos de [probe-source.md](probe-source.md) como `<TEMP>/lohra-w705-agent/<nome>.mjs`, substitua o marcador `C:/<TEMP>` pelo caminho local de `$env:TEMP` com barras `/` e prepare os clones ABI específicos em `<TEMP>/lohra-w705-agent/node20/repo` e `node22/repo`. Os executáveis portáteis esperados ficam em `<TEMP>/lohra-w701/node-v20.20.2-win-x64/node.exe` e `node-v22.23.3-win-x64/node.exe`; em outra disposição, atualize essas constantes nas fontes antes de executar. Então invoque os quatro runners da ABI desejada com seu `node.exe`: `run-corpus[-node20].mjs`, `run-lease-probe[-node20].mjs`, `run-crash-probe[-node20].mjs` e `run-supervision-probe[-node20].mjs`. Os runners Node 20 foram derivados por substituição do diretório `node22`/`node-v22.23.3-win-x64` pelos equivalentes Node 20; a etiqueta `nodeVersion` do `run-corpus-node20.mjs` permaneceu incorreta no metadado, mas o campo `command` e o clone apontam para Node 20. A transcrição preserva o comportamento executado, embora a redação do prefixo impeça equivalência byte a byte com as fontes temporárias originais. Os scripts do checkout referidos por ela permanecem na árvore medida; um harness permanente e automatizado exigiria issue própria. Leituras estáticas ou métodos invocados diretamente não validam entrega de sinais nativos do console.

Hashes SHA-256 dos scripts temporários originais, antes da redação documental:

| Script                             | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `lease-worker.mjs`                 | `1e81e9a0efb00dd825e7a575bf2c6f184cd73bfadb9ae8aea21853ecc23f094c` |
| `read-run.mjs`                     | `2c52165bf991fa76ec34ad9ded7237eee3792c146cca3e491eb7c9c75b569d6f` |
| `resume-audited.mjs`               | `5857c5bf22c1c42e4710089ad77499373f01a960a1e7ca0ca945aacba1f56d75` |
| `run-corpus-node20.mjs`            | `71d81085b8f7f0f873b127b07c88dd8e7322251535121957ae014d265d6f1566` |
| `run-corpus.mjs`                   | `dc52faf749f929b71f52790819ca5ff2ff7d5e169154bcd54f096ca617c9cbb4` |
| `run-crash-probe-node20.mjs`       | `d00e38593fbb8ea7073fb4f26c1b2eff4b5dbac6f0a3a09be9a37f8bd7abe9c4` |
| `run-crash-probe.mjs`              | `46afb7e9074399ebb591ccee25d15b2e0b2ccdedd58c6fa0b1204ec4a684f93c` |
| `run-lease-probe-node20.mjs`       | `f9bae9d3a53c84bcba11eb8cc45929fa3df37b9f599981f7c882fed3fefbdfac` |
| `run-lease-probe.mjs`              | `bee3fddf2a9b91ea7f0c5766516f892b6b25d7dc59cf108b16e0ba4b4b7a2d2d` |
| `run-supervision-probe-node20.mjs` | `a31fa50ebfe9ebfb3c2dba8378dd25e0677dd03bf553c8c143d1218faca60893` |
| `run-supervision-probe.mjs`        | `531e2dd6fbe8320d4f862495ce521d90f4913593110420008e9d4e1b1db415c9` |
| `supervision-worker.mjs`           | `734a23452a4f3d7d887dc77b2c99b832e8fe2a94f6eb12bc26676a7ba5a903c4` |
