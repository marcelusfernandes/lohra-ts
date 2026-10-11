# #841 — fechamento das três fixtures SQLite

Base `17d74fb1daa96c3dcbb960c26181339a2deead23`; vermelho compilável `2fb336847eddbbdb394559ad0e85b690146f2311`; correção `ece3f06ba16b5f4f0dd12fec46240d7a93bbfce8`.

## Vermelho e verde nativos

Clones descartáveis independentes por ABI em `F:/lohra-m25-841/node20` e `node22`, cada um com `npm ci` exit 0. Node 20.20.2 e Node 22.23.2; `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, cache/prefixo npm e `TEMP`/`TMP`/`TMPDIR` próprios em `F:`. Focal por arquivo: `npm run test -- --maxWorkers=1 tests/<arquivo>.test.ts`.

| Arquivo              | Base Node 20                   | Base Node 22                   | Correção em ambas |
| -------------------- | ------------------------------ | ------------------------------ | ----------------- |
| `session-tools`      | 2 falhas `EBUSY`/2             | 2 falhas `EBUSY`/2             | 2/2               |
| `workflow-templates` | 2 falhas `EBUSY`, 16 passes/18 | 2 falhas `EBUSY`, 16 passes/18 | 18/18             |
| `gateway-compaction` | 1 falha `EBUSY`/1              | 1 falha `EBUSY`/1              | 1/1               |

Nos cinco casos vermelhos, o `afterEach` falhava ao remover `state.db` aberto. A correção registra cada conexão logo depois de `openStateDatabase`, fecha as conexões antes das raízes em ordem reversa e tenta todas as etapas de cleanup mesmo quando uma falha. Uma falha é propagada; múltiplas são relatadas por `AggregateError`. As duas conexões explicitamente fechadas nos testes de templates agora pertencem só ao teardown, evitando `close()` duplicado. O diff preserva todos os casos, nomes, assertions e marcadores, sem skip, retry, GC ou timeout novo.

O focal conjunto ficou 21/21 em cada versão. Build, typecheck, lint, format:check e `npm run prova -- windows-session-template-fixture-cleanup` saíram 0 em ambas; prova `{"ok":true,"total":21,"falhas":[]}`. Dogfood N/A, pois só testes, prova e evidências mudaram.

## Sondas de falha transitórias

Em cada família e ABI executei quatro variantes temporárias no clone: falha de setup após registro da conexão; falha de assertion após setup; falha de cleanup após `close()` real; assertion e cleanup simultâneos. Os 24 processos saíram 1 por sentinels intencionais, com zero `EBUSY` e zero raízes residuais no TEMP exclusivo de cada sonda. Nos seis casos combinados o reporter preservou tanto `ASSERTION_SENTINEL` quanto `CLEANUP_SENTINEL`; o primeiro não desapareceu por causa do teardown. Após cada sonda, o arquivo original foi restaurado e os hashes dos três arquivos corresponderam aos do candidato em ambas as ABIs.

O primeiro ensaio de sonda Node 22 teve os argumentos `-t` consumidos pelo wrapper npm e executou mais testes que o filtro pretendido. Seus logs estão preservados fora do repositório em `F:/lohra-m25-841/invalid-probes-argument-filter/` e não contam como evidência das 24 sondas. A repetição válida passou `--testNamePattern` por `-NpmArgs` explícito; [fonte completa e resultados](probe-source.md). Os logs brutos ficam em `F:/lohra-m25-841/`.

## Linux e gates de PR

Clone Linux próprio `/work/lohra841` no container, usuário `node`, HEAD `ece3f06ba16b5f4f0dd12fec46240d7a93bbfce8`; homes, cache e TEMP próprios sob `/tmp/lohra841-isolation`. `npm ci` e os cinco gates canônicos saíram 0. Suíte completa: **340 arquivos, 4.457 testes aprovados e 8 skips preexistentes** em 180,66 s. Prova `{"ok":true,"total":21,"falhas":[]}`. Nenhum skip veio do diff.

`npm run ci:contratos` com evento `pull_request` contendo a base real `17d74fb` e head `ece3f06` retornou `contratos: 4 arquivo(s), nenhuma violação`, exit 0. `npm run ci:controle-negativo -- --base 17d74fb... --head ece3f06... --branch test/841-windows-session-template-fixture-cleanup` saiu 0 com **SKIP test-only**: overlay da classe de testes/prova na base é equivalente ao head e não discrimina. O vermelho nativo por arquivo acima fornece a evidência causal que o mecanismo não mede.

Logs integrais isolados (não versionados) estão em `F:/lohra-m25-841/`, inclusive `linux-evidence/results.tsv`; o clone Linux ficou limpo. SHA-256 do agregado de sondas válido `probe-results.tsv`: `DD047C30864EBF26DBAED7D665C83D9C4A02298663A89659B6722A4C18BC131A`. SHA-256 dos vermelhos Node20/22, respectivamente: `session-tools` `A264B2B7A2F66517F214721E2234EBE645AACAC11CCF5240DA1CE3B10D1E4E63` / `852B842D61FBC7D971A315823145C99C3246307F53C3F15530EC3104CDAF4F31`; `workflow-templates` `B6DDCE69D5149A52560B25EA0BA4A5EBFBFB092AFF5DC6F2689A97F53D6E11B8` / `5768CE9309C499D37EA7034FA5FBDFB7338CE9FF80B9D985076C9FBD73115954`; `gateway-compaction` `FAB08E758420FDAC6940F5ED94878ECCA332673790173249FE3C2CF2AC84ED8F` / `893A3392583D7572AC6429F3C8E4CDBCC2BDF7AC1FA8A1B0ECB1F22DD2DA9F13`.
