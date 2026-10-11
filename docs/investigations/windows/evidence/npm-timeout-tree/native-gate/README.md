# Controle negativo nativo (#904)

O modo `--native` é opt-in. Ele compara uma fonte C# presente no commit
`test(red):` com o HEAD, usando a mesma declaração `prova/<slug>.ts` e os
mesmos bytes finais de `tests/**` e `prova/**`. A fonte fora desse overlay
permanece própria de cada SHA. Drivers C# em `tests/**`, quando declarados em
`--source`, recebem o overlay final. A lista `unit` precisa ser literal; uma
expressão dinâmica, spread ou propriedade computada é recusada.

Exemplo de invocação (substituir caminhos por valores locais próprios):

```text
npm run ci:controle-negativo -- --native --base <BASE> --head <HEAD> --slug <SLUG> --source native/value.cs --source tests/driver.cs --compiler <CAMINHO_ABSOLUTO_CSC>
```

O runner seleciona um único `test(red):` causal em `base..HEAD`; com vários,
exige `--red <SHA>`. Cada worktree recebe uma preparação exclusiva via #898,
verificada antes de executar Vitest. A prova lê o EXE somente por
`LOHRA_NATIVE_HELPER_EXE` no processo filho. Falha de compilação nunca entra
na classificação de asserções. O runner apaga resultados anteriores antes da
prova, valida o JSON novo do Vitest e reconstrói o resumo. Um script `prova`
diferente do harness real é recusado.

O corpus em `tests/ci-controle-negativo-nativo.test.ts` cria repositórios
descartáveis: C# vermelho compila e imprime `RED`, HEAD compila e imprime
`GREEN`; o teste final exige `GREEN`. Também recusa C# inválido, compilador
ausente, vermelho falso ou estrutural, relatório substituído/ausente/inválido,
zero testes, candidato ambíguo, prazo/erro do processo e cleanup com causa
primária preservada. O teste de timeout usa retorno injetado e encerrado;
nenhuma fixture fica pendurada nem cria descendentes.

Linux exercita seleção, declaração e recusas portáteis. A execução do EXE
Windows é **N/A** nesse sistema; não se infere Job Object, árvore de processos,
ACL ou SLA de 300 ms. A rota padrão sem `--native` e os checks obrigatórios de
CI continuam como antes; o roteamento para Windows é trabalho separado.

## Medição

O commit vermelho da própria issue é `82038c3` (stub compilável; a prova
falhou por asserção antes da implementação). O código e o corpus final estão
em `1c3d255`; `112ab91` tem os mesmos arquivos de produção, mas a fixture
portátil ainda usava um caminho de `csc.exe` Windows como entrada do parser
Linux. A primeira suíte Linux nesse SHA terminou com **3 FAIL**
`NATIVE_ARGUMENTS` nessa fixture; preservamos esse ensaio como falha de teste,
não como prova de defeito Windows. `1c3d255` usa `/usr/bin/true` apenas como
caminho absoluto para testes portáteis, sem executá-lo.

| Ambiente                                | SHA       | Resultado                                                                                                                                                                    |
| --------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Node 20.20.2, clone ABI próprio | `112ab91` | `npm ci`, build, typecheck, lint, format e prova: exit 0; prova 15/15.                                                                                                       |
| Windows Node 22.23.2, clone ABI próprio | `112ab91` | Mesmos cinco comandos: exit 0; prova 15/15.                                                                                                                                  |
| Windows Node 20/22, clones ABI próprios | `1c3d255` | Prova repetida: 15/15, exit 0 em cada Node. A mudança desde `112ab91` é só a constante de caminho da fixture Linux.                                                          |
| Linux não root, Node do container       | `1c3d255` | Suíte completa: 345 arquivos, 4541 testes PASS, 19 skips, exit 0 (241,39 s); prova 6/6, nove casos Windows não executados; controle negativo comum `structural-red`, exit 0. |

Os quatro gates leves Linux (`build`, `typecheck`, `lint`, `format:check`)
passaram em `112ab91` antes da correção exclusiva da fixture; o foco Linux e a
suíte completa foram medidos novamente em `1c3d255`. Logs brutos e
temporários isolados estão em `F:/lohra-m25-904/` fora do repositório, sem
importá-los como evidência sanitizada versionada.
