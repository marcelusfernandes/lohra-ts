# #806 — ciclo de vida da fixture de sessões

Base `ae4351a56927cbbd89830aa8570ee31178aa4c2c`; vermelho
`4267d10456a483b024fb86e3dccc8400bba65537`; código verde
`8bdf6f10e188f9b51e1b6c4d39186d84d1081756`, com formatação final
`1aaa75fe57073e64f0f215c4ff84eeeff4257e2b`. Os clones em
`F:/lohra-m25-806/node20` e `F:/lohra-m25-806/node22-ready` receberam
`npm ci` independente, com home, cache e temporários próprios em F:.
`node_modules` não foi compartilhado por junction. O primeiro clone Node22
foi interrompido no setup antes de HEAD e preservado em
`F:/lohra-m25-806/node22`; nenhuma medição usou essa cópia parcial.

Os clones nativos mantiveram HEAD `ae4351a` e receberam apenas o overlay de
`tests/gateway/session-service.test.ts` (modificado) e
`prova/windows-session-fixture-cleanup.ts` (novo). `git diff --name-only`
listou somente o primeiro; `git status --short` listou o segundo como
untracked. Ambos os arquivos foram byte a byte iguais ao commit `1aaa75f`
em cada clone, com SHA-256 respectivamente
`A156C44163D472544E0D0351C07A48DF1E045A3EB5502B660BE3D6D9C883CA34` e
`C2490A4BACFDAB1BD4734E514813FCE625C7879AB88DB30D55E8D82A96697B92`.
Assim, os gates nativos mediram esse conteúdo sobre a árvore base, e não um
checkout Git limpo no SHA candidato.

| Ensaio Windows x64                                                      | Node 20.20.2                        | Node 22.23.2                        |
| ----------------------------------------------------------------------- | ----------------------------------- | ----------------------------------- |
| Base, `vitest run tests/gateway/session-service.test.ts --maxWorkers=1` | exit 1; 0/22; 22 falhas com `EBUSY` | exit 1; 0/22; 22 falhas com `EBUSY` |
| Base, `npm run prova -- windows-session-fixture-cleanup`                | exit 1; 0/22                        | exit 1; 0/22                        |
| Código verde, mesmo focal                                               | exit 0; 22/22                       | exit 0; 22/22                       |
| Código verde, mesma prova                                               | exit 0; 22/22                       | exit 0; 22/22                       |
| Código verde, `build`, `typecheck`, `lint`, `format:check`              | exits 0/0/0/0                       | exits 0/0/0/0                       |

As contagens da base são as desta execução; o focal anterior de #753 mediu
22/22 falhas em Node20 e 21/22 em Node22. A variação não altera o diagnóstico
do handle aberto nesta fixture e não é atribuída a outras famílias de testes.

Na implementação, a raiz entra na lista de cleanup antes da abertura do
banco; a conexão entra imediatamente após `openStateDatabase` retornar.
`afterEach` tenta fechar cada conexão antes de remover a raiz. Se fechamento
ou remoção falhar, coleta os erros e lança `AggregateError` após tentar ambos.
Assim, uma falha de assertion não impede o cleanup nem oculta sua própria
causa no relatório de Vitest.

As sondas delimitadas em [probe-source.md](probe-source.md) derivam do teste
real no clone temporário, injetam falha após abrir a conexão (setup), após
`setup()` (assertion) ou uma falha de fechamento depois de realmente fechar
o banco (cleanup). Executadas em Node20 e Node22, todas tiveram exit 1 como
esperado e **zero arquivos residuais** no diretório temporário isolado. O
relatório JSON preservou `SETUP_SENTINEL_806` ou `ASSERTION_SENTINEL_806` como
causa primária; na terceira sonda preservou também `CLEANUP_SENTINEL_806`
como segunda falha. Nenhuma registrou `EBUSY`.

Relatórios brutos, fontes geradas, comandos e saídas estão em
`F:/lohra-m25-806/` (`focus-*.json`, `prova-*.log`, `probe-*.json`,
`probe-source-*.ts`, `run-probe.ps1`, `run-check.ps1`). Permanecem fora do
repositório por conterem caminhos locais extensos. Nenhuma assertion dos 22
casos foi removida, relaxada ou pulada; não há retry ou GC no teardown.

No Linux x64, Node 22, o clone `/work/lohra806` no container
`lohra-m25-linux-737-20261009` teve checkout limpo no SHA `1aaa75f` e
dependências próprias. `npm ci`, `npm run build`, `npm run typecheck`,
`npm run lint`, `npm run format:check`, `npm test -- --maxWorkers=1` e
`npm run prova -- windows-session-fixture-cleanup` tiveram exit 0. A suíte
passou 336 arquivos, 4387 testes e quatro skips preexistentes; a prova
passou 22/22. O controle negativo sem `--slug`, base `ae4351a` e HEAD
`1aaa75f`, teve exit 0 com classificação explícita `SKIP`: diff apenas em
`tests/**` e `prova/**`, logo a base com overlay é equivalente ao HEAD e o
controle não discrimina. O vermelho nativo real e o commit `test(red):`
fundamentam a regressão. Logs e `results.tsv` em
`F:/lohra-m25-806/linux-evidence/`.

CI e revisão independente: pendentes neste checkpoint.
