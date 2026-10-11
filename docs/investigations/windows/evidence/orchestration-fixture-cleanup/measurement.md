# #836 — ciclo de vida SQLite da fixture de orquestração

Base `bc8abacfa80df9c1325ec19d4def0a0dd180ddb1`; vermelho compilável `060c54b65b0cbe835fc03d5aa7e711332c944abf`; verde `9981aadfe67d2ffafa692fcc42566d027761cae6`. Medição em 2026-10-11 em clones F: separados por ABI, cada um com `npm ci`, home/cache/temp próprios. Sem código de produto ou provider externo (dogfood N/A para tests/prova/docs).

## Vermelho e reparo

O baseline `npm test -- --maxWorkers=1 tests/orchestration-chat-wiring.test.ts` registrou **4 testes aprovados e 4 falhas EBUSY** em Node 20 e Node 22. As quatro falhas eram `unlink state.db` no `afterEach`, dos casos de fanout, custo e prompt. `setupSessions()` adquiria a conexão SQLite, mas o teardown tentava remover o root sem fechá-la. SHA-256 dos logs: `baseline-20.log` `FFD8873B203DA3BF2ECF9F51EC49BA4501358E562A355DFDA8D10A05FCE11D9D`; `baseline-22.log` `7A5670A4070BC7E06F4CB7283555DC2407AD90059BF52720062D68396FC33761`.

A fixture agora registra `root` imediatamente após criação e `connection` imediatamente após aquisição. O `afterEach` fecha cada conexão antes de remover o root, tenta ambos mesmo quando um passo falha e relata os erros de cleanup em `AggregateError`. Isso cobre também falha entre criação do root e aquisição da conexão. Os oito nomes `it(...)` antes/depois são idênticos; assertions, marcadores, fanout, custo, prompt e timeouts não mudaram. Focal verde: **8/8 em ambas as ABIs**.

## Sondas transitórias de falha

Fonte completa em [replay.md](replay.md), acrescentada **somente nos clones descartáveis** e removida antes dos gates; hashes do arquivo candidato foram comparados e iguais após restauração. A sonda de setup força `createSession` a lançar `SETUP_SENTINEL` depois da aquisição e verifica que essa causa é recebida. A sonda de assertion lança `ASSERTION_SENTINEL`. A sonda de cleanup fecha a conexão real e então lança `CLEANUP_SENTINEL`. A combinada lança `PRIMARY_ASSERTION_SENTINEL` no corpo e `SECONDARY_CLEANUP_SENTINEL` depois do close; o reporter exibiu ambas, nessa ordem, em Node 20/22. `afterAll` verificou que todos os roots dessas sondas tinham sido removidos. O exit **1 é esperado** nessas sondas de injeção; `EBUSY` não aparece. Logs `fault-probes-combined-{20,22}.log` sob `F:\lohra-m25-836`; SHA-256 Node20 `D1ADDFD4234F74FE21489686EF23E4549B3B525A9639A9DBE76CD3843CC0B410`, Node22 `43241B1C819983C7C22891D43751EA7B1DB4B2B6681DFC5F108E93098B5FCBB3`.

## Gates nativos

| ABI                       | `npm ci` | build | typecheck | lint | format:check | prova       |
| ------------------------- | -------- | ----- | --------- | ---- | ------------ | ----------- |
| Node 20.20.2 x64 portátil | 0        | 0     | 0         | 0    | 0            | 8/8, exit 0 |
| Node 22.23.3 x64 host     | 0        | 0     | 0         | 0    | 0            | 8/8, exit 0 |

Provas em `F:\lohra-m25-836\node{20,22}\.prova\windows-orchestration-fixture-cleanup\resumo.json`, `ok:true,total:8,falhas:[]`; logs brutos em `F:\lohra-m25-836\<etapa>-<ABI>.log`. Nenhuma junction compartilha ABI ou deps com outros worktrees.

## Linux e controle negativo

Clone independente `/work/lohra836` no container `lohra-m25-linux-20261009`, usuário `node`, SHA `9981aadfe67d2ffafa692fcc42566d027761cae6`, com dependências e HOME/LOHRA_HOME/CODEX_HOME/TMP próprios. `npm ci`, build, typecheck, lint, format:check, suíte completa com `--maxWorkers=1`, prova e controle negativo retornaram **0**. A suíte teve **339 arquivos, 4444 testes aprovados, 4 skips existentes**; a prova, **8/8**. O controle negativo test-only deu `SKIP` porque base+overlay equivale ao head no diff só de tests/prova; o vermelho real e as sondas são a evidência discriminante. Logs em `F:\lohra-m25-836\linux-evidence\`; SHA-256 `test.log` `1B086D3E23ABC948D42176196B977245D296E47031C4AA4A5CC7FE9CAB9F225C`. `git status --short` no clone Linux estava vazio após os gates.
