# #811 — ciclo de vida da fixture leaf-read

Base `06d81a1d93fd338bf26aa4ce7d6c7b3258d3e27f`; commit vermelho
`e32d96e18170ceea6b5181382f7b5dc6b1f81287`; código verde
`71d34e6bc7d56508a567b5877ea32f4193829641`. Dois clones Git em
`F:/lohra-m25-811/node20` e `F:/lohra-m25-811/node22` instalaram
dependências com `npm ci` separados por ABI. Home, cache npm e diretórios
temporários foram próprios em F:; `node_modules` eram diretórios regulares,
sem junction.

Cada clone nativo manteve HEAD `06d81a1` e recebeu apenas overlay de
`tests/workflow-leaf-read-tool.test.ts` (modificado) e
`prova/windows-leaf-read-fixture-cleanup.ts` (novo). `git diff --name-only`
listou somente o primeiro e `git status --short` listou o segundo como
untracked. Os dois arquivos tinham bytes idênticos ao commit `71d34e6` em
ambos os clones, SHA-256 respectivamente
`0F6C88DF4AF27FEBC9C24E6D6F21AF3AE7AA2517F2D5346A4C7FB3661CE2E9FA` e
`89DDA8E7A0A3088EB9B751D7066370EC93AA52B295BDDB4979129B0399F95511`.
Assim, os ensaios nativos mediram o conteúdo candidato sobre a árvore base;
os clones não alegam checkout Git limpo no SHA candidato.

| Ensaio Windows x64                                                      | Node 20.20.2                        | Node 22.23.2                        |
| ----------------------------------------------------------------------- | ----------------------------------- | ----------------------------------- |
| Base, `vitest run tests/workflow-leaf-read-tool.test.ts --maxWorkers=1` | exit 1; 1 PASS, 13 FAIL com `EBUSY` | exit 1; 1 PASS, 13 FAIL com `EBUSY` |
| Base, `npm run prova -- windows-leaf-read-fixture-cleanup`              | exit 1; 13 falhas                   | exit 1; 13 falhas                   |
| Código verde, mesmo focal                                               | exit 0; 14/14                       | exit 0; 14/14                       |
| Código verde, mesma prova                                               | exit 0; 14/14                       | exit 0; 14/14                       |
| Código verde, `build`, `typecheck`, `lint`, `format:check`              | exits 0/0/0/0                       | exits 0/0/0/0                       |

A contagem vermelha é a medida desta rodada, não uma exigência fixa. Treze
casos abrem o banco; o teste de exclusão de subagentes não chama o harness e
já passava na base. Nenhum caso, nome, marcador `MUTATION_CAUSE`, assertion
ou expectativa funcional foi removido ou relaxado.

O harness agora registra a raiz logo após `mkdtempSync` e a conexão
imediatamente após `openStateDatabase` retornar. `afterEach` tenta fechar a
conexão antes de remover a raiz; coleta falhas de ambos passos e lança
`AggregateError` se houver erro de cleanup. Isso opera mesmo se a criação
dos repositórios ou uma assertion falhar depois de abrir o banco.

As sondas descritas em [probe-source.md](probe-source.md) derivam do teste
real num clone descartável e injetam falha de setup após a abertura, falha
de assertion após `harness()`, ou falha de close após fechar de fato o banco.
Em Node20 e Node22, cada uma teve exit 1 esperado e **zero arquivos
residuais** no diretório temporário isolado. O JSON manteve a causa primária
`SETUP_SENTINEL_811` ou `ASSERTION_SENTINEL_811`; na terceira sonda manteve
também `CLEANUP_SENTINEL_811` como segunda mensagem. Nenhuma teve `EBUSY`.
Não há GC nem retry de deleção.

Fonte, comandos e saídas brutas ficaram em `F:/lohra-m25-811/`:
`focus-*.json`, `prova-*.log`, `probe-*.json`, `probe-source-*.ts`,
`run-check.ps1` e `run-probe.ps1`. Os logs extensos não foram copiados ao
repositório porque contêm caminhos locais de fixture.

No Linux x64, Node 22, o clone `/work/lohra811` no container
`lohra-m25-linux-737-20261009` teve checkout limpo em `71d34e6` e
dependências próprias. `npm ci`, `npm run build`, `npm run typecheck`,
`npm run lint`, `npm run format:check`, `npm test -- --maxWorkers=1` e
`npm run prova -- windows-leaf-read-fixture-cleanup` tiveram exit 0. A
suíte passou 336 arquivos, 4393 testes e quatro skips preexistentes; a
prova passou 14/14. O controle negativo sem `--slug`, base `06d81a1` e
HEAD `71d34e6`, teve exit 0 com `SKIP` explícito: diff só em `tests/**` e
`prova/**`, que não discrimina base+overlay do HEAD. A regressão vermelha
nativa e o commit `test(red):` são evidências independentes. Logs completos
e `results.tsv` em `F:/lohra-m25-811/linux-evidence/`.

A suíte Linux anterior de #802 tinha 4389 testes passados (mais os mesmos
quatro skips). A comparação por arquivo dos logs mostra somente
`tests/prova-declaracoes.test.ts` diferente: 609 testes antes, 613 agora.
Esse teste gera duas assertions por declaração de prova; desde #802 entraram
exatamente os slugs `windows-session-fixture-cleanup` (#806) e
`windows-leaf-read-fixture-cleanup` (#811), somando quatro testes. Os demais
335 arquivos mantiveram sua contagem. O clone Linux estava limpo no SHA
`71d34e6`, sem arquivos de sonda sob `tests/`.

CI e revisão independente: pendentes neste checkpoint.
