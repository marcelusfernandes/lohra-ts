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
exige `--red <SHA>`. `BASE` precisa ser ancestral de `HEAD`:
`git merge-base --is-ancestor <BASE> <HEAD>` deve retornar 0. Se a base
avançou, integre-a por merge antes desta rota; ela não avalia um histórico
divergente. Cada worktree recebe uma preparação exclusiva via #898,
verificada antes de executar Vitest. A prova lê o EXE somente por
`LOHRA_NATIVE_HELPER_EXE` no processo filho. Falha de compilação nunca entra
na classificação de asserções. O modo nativo chama diretamente o entrypoint
`scripts/prova/run.ts` do runner em execução, com `cwd` no checkout red ou
HEAD; não usa o comando de `package.json` nem seus hooks `preprova` e
`postprova`. Um comando absoluto na fixture só é aceito se resolve para esse
entrypoint; o comando relativo canônico exige que `scripts/prova/run.ts` do
checkout tenha os mesmos bytes. Essa vinculação não afirma isolamento de
testes arbitrários. O runner apaga resultados anteriores antes da prova,
valida o JSON novo do Vitest e reconstrói o resumo.

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
falhou por asserção antes da implementação). A regressão da revisão R2 é
`e1439cb`: dois testes compiláveis mostraram que um script falso com o mesmo
sufixo e um `run.ts` relativo adulterado eram executados; o código anterior
só falhava depois, ao procurar o relatório. O código final está em `900cf23`.
A fixture portátil em `112ab91` ainda usava um caminho Windows de `csc.exe`
como entrada do parser Linux. A primeira suíte Linux nesse SHA terminou com **3 FAIL**
`NATIVE_ARGUMENTS` nessa fixture; preservamos esse ensaio como falha de teste,
não como prova de defeito Windows. `1c3d255` usa `/usr/bin/true` apenas como
caminho absoluto para testes portáteis, sem executá-lo.

| Ambiente                                | SHA       | Resultado                                                                                                                                                                                 |
| --------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows Node 20.20.2, clone ABI próprio | `096e534` | `npm ci`, build, typecheck, lint, format e prova: exit 0; prova 16/16.                                                                                                                    |
| Windows Node 22.23.2, clone ABI próprio | `096e534` | Mesmos comandos: exit 0; prova 16/16.                                                                                                                                                     |
| Linux não root, Node 22.23.3            | `096e534` | Cinco gates: exit 0; suíte completa: 345 arquivos, 4542 testes PASS, 19 skips (218,48 s); prova 7/7, nove casos Windows não executados; controle negativo comum `structural-red`: exit 0. |
| Windows Node 20.20.2, clone ABI próprio | `900cf23` | Build, typecheck, lint, format e prova: exit 0; prova 19/19.                                                                                                                              |
| Windows Node 22.23.2, clone ABI próprio | `900cf23` | Mesmos comandos: exit 0; prova 19/19.                                                                                                                                                     |
| Linux não root, Node 22.23.3            | `900cf23` | Cinco gates: exit 0; suíte completa: 345 arquivos, 4542 testes PASS, 22 skips (203,53 s); prova 7/7, 12 casos Windows não executados; controle negativo comum `structural-red`: exit 0.   |

Os quatro gates leves Linux (`build`, `typecheck`, `lint`, `format:check`)
passaram em `112ab91` antes da correção exclusiva da fixture; o foco Linux e a
suíte completa foram medidos novamente em `1c3d255` e no código final
`096e534`; a correção R2 `900cf23` foi medida em ambas as ABIs e no Linux.
Logs brutos e temporários isolados estão em `F:/lohra-m25-904/`
fora do repositório, sem
importá-los como evidência sanitizada versionada.
