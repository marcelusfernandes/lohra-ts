# #813 — fechamento das fixtures RPC e raw sockets

Base `3ae55886cc8236bad42de5e92e116944f8071146`; vermelho compilável
`96c79717d76d58d520b4b4c2370ade91ef57361c`; código verde `870912e1`,
seguido de formatação `f92d0fc9fb1090d3cd37369d4608d4d6956eba7e`. Dois clones Git
independentes em `F:/lohra-m25-813/node20` e `node22` instalaram `npm ci`
separadamente, com `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, cache npm,
`TEMP` e `TMP` isolados em F: **fora** dos clones. `node_modules` é diretório
regular, sem junction. Nodes 20.20.2 e 22.23.2 em Windows x64.

Cada clone manteve HEAD na base e recebeu somente overlay dos dois testes e da
declaração de prova. Os SHA-256 dos arquivos versionados da branch final são
idênticos aos dois overlays, nesta ordem:

| Arquivo                                       | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `tests/gateway/rpc-dispatch.test.ts`          | `BE7864AAC22AD2464B500B27B1BF6C6FA4C47CD5A46B9F04697E20B9139DFB4B` |
| `tests/gateway/raw-socket-primitives.test.ts` | `4B234339CCFE188A28670FDF1840655D21F6A3A8E6736D34FF0DE5F55D941163` |
| `prova/windows-rpc-raw-fixture-cleanup.ts`    | `B23D030D75AB06A8106AD6D1CABBDD83C635085574412E9D78961143212C151F` |

Os ensaios nativos mediram o conteúdo candidato sobre a árvore base; **não** se
declara checkout Git limpo no SHA candidato. Com `npm test -- <arquivo>` por
arquivo, o vermelho da base foi:

| Arquivo                         | Node 20                        | Node 22                        |
| ------------------------------- | ------------------------------ | ------------------------------ |
| `rpc-dispatch.test.ts`          | exit 1; 8 FAIL `EBUSY`, 2 PASS | exit 1; 8 FAIL `EBUSY`, 2 PASS |
| `raw-socket-primitives.test.ts` | exit 1; 6 FAIL `EBUSY`         | exit 1; 6 FAIL `EBUSY`         |

`npm run prova -- windows-rpc-raw-fixture-cleanup` também teve exit 1 na base,
com o mesmo bloqueio de cleanup. Depois da correção, a prova completa passou
16/16 em ambos os Nodes (exit 0). `build`, `typecheck`, `lint` e `format:check`
tiveram exit 0 em ambas as ABIs no conteúdo final formatado. Nomes, número de
casos, assertions de RPC, autenticação, frames e protocolos não foram alterados.

O RPC registra a raiz após criar o diretório e a conexão imediatamente após
`openStateDatabase`; depois fecha o banco antes de `rm`. A fixture raw segue
servidor → banco → diretório. Em ambas, cada etapa de cleanup é tentada mesmo
se outra falhar; os erros são acumulados num `AggregateError`, preservando a
falha original do teste no reporter do Vitest.

[A fonte das sondas](probe-source.md) deriva cópias temporárias dos testes
reais nos clones, sem editar os testes versionados. Foram 12 execuções:
setup, assertion e cleanup para cada arquivo e cada Node. Todas tiveram exit 1
esperado, sentinelas de causa primária presentes, nenhuma ocorrência de
`EBUSY` e zero resíduos no `TEMP` exclusivo. A sonda RPC cleanup registra
também `DB_CLEANUP_SENTINEL_813`; a raw cleanup fecha o servidor, religa sua
porta para provar liberação e registra
`SERVER_CLEANUP_SENTINEL_813_PORT_RELEASED` junto da causa original.
Sondas com falha de fechamento **antes** de liberar a porta não foram feitas;
nesse caso a exceção é reportada, sem promessa de porta livre.

Logs brutos e fontes geradas: `F:/lohra-m25-813/red-*.log`,
`final-*.log`, `probe-*.json`, `probe-result-*.json`,
`probe-source-*.ts` e `probe.mjs`. Os logs extensos ficam fora do repositório
porque contêm caminhos locais da fixture.

No Linux x64, Node 22, o clone `/work/lohra813` no container
`lohra-m25-linux-20261009` teve checkout limpo em `f92d0fc` e dependências
próprias. `npm ci`, `build`, `typecheck`, `lint`, `format:check`,
`npm test -- --maxWorkers=1` e a prova tiveram exit 0. A suíte passou 336
arquivos, 4397 testes, com quatro skips preexistentes; a prova passou 16/16.
O controle negativo sem `--slug`, base `3ae5588`/head `f92d0fc`, teve exit 0
com `SKIP` explícito: diff só `tests/**+prova/**` e, portanto, base+overlay
equivale ao HEAD; o vermelho nativo é a evidência discriminante. Logs completos
e exits estão em `F:/lohra-m25-813/linux-evidence/`.

Frente à suíte Linux anterior de #811 (4393 PASS, quatro skips), a diferença
de quatro testes está somente em `tests/prova-declaracoes.test.ts` (613 →
617). Entre os SHAs entrou `prova/windows-serve-process-signal.ts` (#804,
dois casos declarativos) e esta PR adiciona
`prova/windows-rpc-raw-fixture-cleanup.ts` (mais dois). Os outros 335 arquivos
mantiveram sua contagem, incluindo as duas fixtures alteradas (10 e 6).
