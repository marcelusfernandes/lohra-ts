# #838: fixtures de processo do agregador de mutações

Medição em Windows 11 x64, Node 20.20.2 e 22.23.2, em clones separados com
`npm ci` por ABI e `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, `TEMP`,
`TMP` e cache npm próprios em F:. Base `b529b956a6f09907e2f9c9c1e578f1e2b5c62077`.
Nenhum runner real de mutações foi executado: o entrypoint recebe um
`slices.json` falso em diretório temporário próprio.

## Vermelho e causa observada

O comando focal foi `node node_modules/vitest/vitest.mjs run
tests/mutations-all.test.ts --maxWorkers=1` com o executável da ABI. Em ambas,
41 testes foram executados: 35 passaram e 6 falharam. O Node 20 teve também
falha secundária `EBUSY` na limpeza do caso de timeout, enquanto `clean3`
passou; no Node 22 o `clean3` falhou. Esse conjunto de seis por ABI não é o
mesmo conjunto de IDs. Os logs de bancada, externos ao repositório, estão em
`F:/lohra-m25-838/node20-red-focused.log` e `node22-red-focused.log`.

| Mecanismo na base                         | Node 20                                                                                                            | Node 22                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `realExecute("sleep")`                    | `status=null`, `signal=SIGTERM`, `error.code=ETIMEDOUT`, saída npm, `stderr=""`; houve `EBUSY` secundário no teste | `status=1`, `signal=null`, sem `error`; comando com caminho `C:\Program Files` sem aspas falhou antes do filho |
| `realExecute("killself")`                 | `status=1`, `signal=null`, sem `error`, saída npm, `stderr=""`; não há relatório                                   | `status=1`, `signal=null`, sem `error`; comando sem aspas falhou antes do filho                                |
| `realExecute("clean3")`                   | `status=3`, `signal=null`, sem `error`, relatório JSON impresso                                                    | `status=1`, `signal=null`, sem `error`; caminho sem aspas, nenhum relatório                                    |
| `spawnSync(node, SIGKILL)`                | `status=1`, `signal=null`, sem `error`                                                                             | igual                                                                                                          |
| `spawnSync("sh", …)` para SIGKILL/SIGTERM | `status=null`, `signal=null`, `error.code=ENOENT`, saída ausente                                                   | igual                                                                                                          |
| `spawnSync("npm", …)` do entrypoint       | `status=null`, `signal=null`, `error.code=ENOENT`, saída ausente                                                   | igual                                                                                                          |

Os campos brutos `status`, `signal`, `error`, `stdout` e `stderr` da sonda estão
em `F:/lohra-m25-838/node20-baseline-probe.json` e
`node22-baseline-probe.json`. O checkpoint `test(red):` compilável
`c5b84fb21a689b5926e4479a4a2bcab2091e8f53` reproduziu, nas duas ABIs,
o caso novo de executável Node com espaços sem aspas: retorno 1 em vez de 3.

## Contrato da fixture corrigida

O projeto falso grava `child.js` e usa o Node entre aspas, com `call` para o
`cmd.exe` do npm no Windows. O entrypoint chama `runNpmSync` com o mesmo
`cwd`, timeout de 60 s, ambiente herdado e `MUTATIONS_ALL_SLICES_PATH` falso.
As saídas nativas após lançar o filho são:

| Caso                                               | Windows 20/22                                                                                                         | POSIX                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Filho se mata por `SIGKILL`, direto ou via npm/cmd | marcador de início; `status=1`, `signal=null`, sem `error`, `stderr=""`; `evaluateRun` exige `MUTATION_ALL_NO_REPORT` | sinal direto `SIGKILL` ou conversão pelo shell em `137`; exige `MUTATION_ALL_KILLED:SIGKILL` |
| Filho se mata por `SIGTERM` via shell              | marcador de início; `status=1`, `signal=null`, sem `error`, `stderr=""`; exige `NO_REPORT`                            | status `143`; exige `KILLED:SIGTERM`                                                         |
| Relatório limpo e `exit(3)`                        | relatório esperado, `status=3`, `signal=null`, sem `error`                                                            | igual                                                                                        |
| Timeout de `realExecute`                           | `status=null`, `signal=SIGTERM`, `error.code=ETIMEDOUT`                                                               | mesmo contrato assertado                                                                     |

Os testes unitários de `evaluateRun` para `KILLED`, `EXIT` e `NO_REPORT`
continuam estritos. Nenhum sinal POSIX é inferido de `status=1` no Windows.
Um teste novo executa a mesma fonte do filho sem STOP e exige término próprio,
marcador de conclusão e `status=0` após 5 s; o foco ficou 43/43 nas duas ABIs.

## Limite da medição de timeout

`realExecute` usa timeout de 300 ms. A fixture escreve STOP apenas no
diretório temporário próprio; o filho também encerra o próprio intervalo em
até 5 s se STOP não chegar. No Windows, observa por até 6 s o marcador de PID do
próprio filho, e, se ele iniciar, exige marcador de conclusão e saída antes da
única tentativa de remover o diretório. Não encerra PID alheio nem faz retry
de `rm`. Erro da asserção e erro do teardown são preservados juntos.

A sonda `F:/lohra-m25-838/tree-watch-probe.mts` observou no Node 20 o
marcador do filho **após** o lançamento retornar `ETIMEDOUT` (não existia aos
319 ms e apareceu durante a janela posterior de 5 s). No Node 22, o marcador
não apareceu na mesma janela. Ausência de marcador não prova encerramento da
árvore. Este teste demonstra o timeout do lançador, não que o script tenha
sido morto; a lacuna de produção está rastreada em [#877](https://github.com/marcelusfernandes/lohra-ts/issues/877).
