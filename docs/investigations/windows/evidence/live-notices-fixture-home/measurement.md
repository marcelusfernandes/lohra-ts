# #835 — home de live tail e notices

## Ambiente

- Base `ceaf81e492e3baffe0dea9eb05d1b8a66d9c8cbd`; declaração vermelha `308aaa3`; código verde `4603b1af2e9430e08da2de2b61ecc38e6cf4d6f7`.
- Windows 11 x64, Node 20.20.2 portátil e Node 22.23.2 do host. Clones descartáveis e instalações `npm ci` separados por ABI em `F:/lohra-m25-835/node20` e `node22`, com HOME/USERPROFILE/LOHRA_HOME/CODEX_HOME/cache npm/TEMP próprios sob `F:/lohra-m25-835/isolation-{20,22}`. Stubs usam apenas loopback; nenhum provider real.

## Vermelho antes do overlay

Comando: `npm test -- --maxWorkers=1 tests/workflow-live-tail.test.ts tests/workflow-notices-sink.test.ts`. Em **cada ABI**, os dois arquivos registraram **34 PASS, 3 FAIL (37 casos)**:

| Teste                                   | Causa primária                                                                                                    | Secundária                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| live tail por `runChat`                 | `ENOENT` em `lstat <tmp>/.lohra` antes de validar `live_tail`                                                     | `EBUSY` no teardown de `lohra/state.db` |
| live tail por `runDashboard`            | `AssertionError: expected undefined to be defined`; o log também traz `ENOENT` assíncrono em `lstat <tmp>/.lohra` | nenhuma falha adicional de caso         |
| notices por `runChat` e segunda conexão | `ENOENT` em `lstat <tmp>/.lohra` antes de ler os notices                                                          | `EBUSY` no teardown de `lohra/state.db` |

Logs brutos `F:/lohra-m25-835/baseline-{20,22}.log` preservam nomes completos, stacks e caminhos por execução. Os diretórios residuais do baseline (chat e notices) ficam somente nos temporários próprios em `F:`; não foram apagados. O dashboard não gerou resíduo observado. EBUSY é tratado como erro de limpeza posterior, não como uma quarta ou quinta falha funcional.

## Verde do mesmo corpus

As três chamadas de entrada agora têm `environment.LOHRA_HOME = join(root, ".lohra")`, exatamente igual ao `options.home` já usado; no teste de notices coincide também com o caminho da segunda conexão. Não houve alteração de nomes, marcadores, assertions, stderr esperado, protocolo, timeouts, `src/` ou ambiente global. O mesmo foco passou **37/37** em Node 20 e 22 (`green-focus-{20,22}.log`); não apareceram novos resíduos no TEMP após o verde. A prova também passou **37/37** nas duas ABIs (`proof-{20,22}.log`).

Build, typecheck e lint concluíram exit 0 nas duas ABIs. O primeiro `format:check` falhou exclusivamente no layout da nova linha `environment` de notices; `82b7ee1` ajustou somente a quebra de linhas. Os arquivos de código medidos depois dessa correção tiveram SHA-256 idêntico ao worktree nos clones Node 20 e 22 (tabela em `procedure.md`). No código e documentação finais, build, typecheck, lint, format:check e prova 37/37 foram repetidos em Node 20 e 22, todos exit 0; logs `F:/lohra-m25-835/{build-final,typecheck-final,lint-final,format-final,proof-final}-{20,22}.log`. Dogfooding real: **N/A**, pois o diff contém somente testes, prova e documentação.

## Linux pinado

O clone `/work/lohra835` no SHA `82b7ee1d9767b4f53f1fd8c219452db199a25f8f`, como usuário não privilegiado `node`, com deps/home/TMP próprios, concluiu `npm ci` e os **cinco gates canônicos com exit 0**. A suíte completa (`--maxWorkers=1`) registrou **338 arquivos, 4.429 PASS + 4 skips**, em 163,68 s. A prova passou **37/37**. O controle negativo retornou exit 0 e `SKIP — diff só de tests/**+prova/**: base+overlay ≡ head`, mecanismo esperado para test-only; o vermelho comportamental nativo está preservado acima. `git status --short` permaneceu vazio.

Logs e exits: `F:/lohra-m25-835/linux-evidence/{head.txt,status.txt,results.tsv,npm-ci.log,build.log,typecheck.log,lint.log,format.log,test.log,prova.log,negative.log}`. O código medido no Linux é o mesmo overlay dos clones nativos; edições posteriores nesta evidência são só documentais.
