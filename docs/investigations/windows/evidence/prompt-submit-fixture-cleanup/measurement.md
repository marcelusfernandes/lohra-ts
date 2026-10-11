# #814 — ciclo de vida da fixture `prompt.submit`

Base `28cb79988ecc30a2bac2440be8cfe4bff920ba3f`; commit vermelho `cd72117f428cc82a67ac6a1e481d27c92156709d`; código verde `61a32f0e2071cf39e150cc87a99ae367df015b4c`. As medições nativas usam clones descartáveis e dependências próprias por ABI, Node 20.20.2 e Node 22.23.3, com `HOME`, `USERPROFILE`, `LOHRA_HOME`, `CODEX_HOME`, cache npm e `TEMP` fora do Git. As sondas instrumentaram cópias temporárias dos testes só nesses clones; a árvore de produto não foi alterada.

| Etapa                                                       | Node 20                                                                   | Node 22                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Base, `npm run test -- tests/gateway/prompt-submit.test.ts` | Exit 1; 16 falhas por `EBUSY` no `state.db`                               | Exit 1; 16 falhas por `EBUSY` no `state.db`                               |
| Prova declarada no commit vermelho                          | Exit 1, 16 falhas                                                         | Exit 1, 16 falhas                                                         |
| Prova no código verde                                       | Exit 0, 16/16                                                             | Exit 0, 16/16                                                             |
| Sondas de setup, assertion, server-cleanup e db-cleanup     | Quatro falhas induzidas, causa esperada presente, sem `EBUSY` nem resíduo | Quatro falhas induzidas, causa esperada presente, sem `EBUSY` nem resíduo |
| `build` → `typecheck` → `lint` → `format:check`             | Quatro exits 0                                                            | Quatro exits 0                                                            |

Os 16 testes e suas asserções permanecem no arquivo original. A região desde `messageQueues` é idêntica à base, e nenhum `it`/`describe` foi movido. A infraestrutura extraída registra a raiz imediatamente e a conexão assim que `openStateDatabase` retorna. O teardown tenta servidor → banco → remoção, prosseguindo após falha de cleanup e agregando essas falhas. A sonda de `server-cleanup` fecha o servidor, religa a mesma porta e só então injeta erro; a de `db-cleanup` fecha a conexão antes de injetar erro. Isso demonstra a ordem e a preservação de causa nos cenários cobertos; não promete liberar uma porta se `server.close()` falhar antes de encerrar o listener.

O [driver completo](probe-source.md) gera cópias instrumentadas dos dois arquivos de teste apenas nos clones, seleciona um caso com Vitest, valida os sentinels de falha primária e secundária, verifica `EBUSY` e diretório `TEMP` vazio, e arquiva as fontes instrumentadas fora do checkout. SHA-256 do driver executado: `c2a66772363f026fcc5f6de46d9aa735f10e6d6ea37cde541ccd9fff53ad78c3`. As saídas brutas e fontes geradas estão em `F:/lohra-m25-814/` na máquina de medição; este documento contém os resultados sanitizados.

## Validação Linux e limites

Em clone próprio no Linux, Node 22.23.3, `npm ci`, `build`, `typecheck`, `lint`, `format:check` e `npm test -- --maxWorkers=1` terminaram com exit 0 no código verde. A suíte teve 336 arquivos, 4401 testes aprovados e quatro skips preexistentes (183,44 s de duração reportada pela suíte). A prova `npm run prova -- windows-prompt-submit-fixture-cleanup` terminou exit 0, 16/16. O controle negativo terminou exit 0 com `SKIP`: a alteração é test-only e a base com overlay equivale ao head; o commit `test(red)` e o vermelho nativo registram a discriminação comportamental. Dados brutos ficam em `F:/lohra-m25-814/linux-evidence/` na máquina de medição.

O Linux mediu o código verde antes desta nota documental. Dogfooding do runtime: N/A, pois a mudança limita-se a testes, prova e documentação. CI e revisão independente ficam para a PR.
