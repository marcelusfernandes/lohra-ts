# Closeout de paridade TypeScript

Este documento registra a integração T00–T22. Os SHAs T00–T21 abaixo são os
heads aprovados exatos e precisam permanecer ancestrais do SHA final T22.

A fonte canônica, legível por máquina, é [`docs/provenance.json`](provenance.json);
a tabela abaixo é a prosa correspondente e um teste bidirecional reprova se
uma divergir da outra. [`docs/provenance.md`](provenance.md) descreve o
formato do JSON, o script de verificação e as flags.

| Ticket | SHA aprovado                               | Resultado                             |
| ------ | ------------------------------------------ | ------------------------------------- |
| T00    | `5b2d62c65f282683609d5d3801b3bfaf4448aff4` | integrado                             |
| T01    | `8901ea084e5797980650bd512f4fcd8fe251c952` | integrado                             |
| T02    | `931e0faf599d2017fabed1e47a12467227b69feb` | integrado                             |
| T03    | `3175a936e0f4c03af8380daf4f5dbd192a742500` | integrado                             |
| T04    | `4655d8ad8ad1fc3d168c92fe3144c4aab1d1b1cb` | integrado                             |
| T05    | `dc419d078f330470b111e2f8ec6e582ad65eecca` | integrado                             |
| T06    | `006ea20c3894fa7c90c576ad3d152cb1d45bda6e` | integrado                             |
| T07    | `141ef75c8950e24bf3d5ae9c346bfbf93e9f4349` | integrado                             |
| T08    | `8d80d8adb4717722ac0337aaf7ab3ad4a6b4cc02` | integrado                             |
| T09    | `f11443e2425439065e08a8a25b39c4585ddbab95` | integrado                             |
| T10    | `bc9a487e06523c3018561b5d13bb402c0370a586` | integrado                             |
| T11    | `2f212dea99dfa924a388243f8068e6dfe204590d` | integrado                             |
| T12    | `e4415ddabd6bf27196f443f7c95e282ebcef86af` | integrado                             |
| T13    | `7703b2f7bd8a604d24246ed5cd21e1cb74e3e86b` | integrado                             |
| T14    | `a69bbcaa889f111a9b1d5c6760bf21e89e74f0fc` | integrado                             |
| T15    | `0023a6b58f4264ec7fb3ca52607efd10144f84ce` | integrado; Evaluator 100/100          |
| T16    | `45a2f7d7f1e8a2f1e8ed50df8e53368d3237dd13` | integrado; Evaluator 100/100          |
| T17    | `846daf9c3de7766b1736d02a1a4b3a52fa02d5f2` | integrado; Evaluator 99/100           |
| T18    | `879b16788d83ab32d45216c25403e9b4b8faecb1` | integrado                             |
| T19    | `78b93ec89995ae72f275ec58c1acea5739b96da9` | integrado; Evaluator 98/100           |
| T20    | `9d98cc97473f5523d0a961ef48073456db40522d` | integrado; Evaluator 100/100          |
| T21    | `3c39315f48665eea5230b03c6c57ddd25fe377bb` | integrado; QA 100/100                 |
| T22    | `EVIDENCE_BOUND_FINAL_SHA`                 | SHA exato vinculado no evidence index |

## União semântica dos hotspots

| Path                             | Intenções preservadas                                                        | Prova principal                        |
| -------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| `package.json` e lock            | 0.0.11 público, scripts de todas as lanes, `node-pty`, bin/files/postinstall | pack-check, fresh install e inventário |
| `src/cli.ts`                     | dashboard, workflow, cron, update e ordem pública exata                      | process tests/help                     |
| `src/commands/chat.ts`           | workflow/audit, orquestração, MCP, web e mídia                               | composition probe em processo `dist`   |
| `src/commands/dashboard.ts`      | mesma registry pública, gateway WS e scheduler real                          | HTTP/WS + SQLite do composition probe  |
| `src/tools/builtins.ts`          | builtins, overrides, web e hooks compartilhados                              | tool definitions/results reais         |
| `tests/parity/scenarios.test.ts` | manifests aprovados das lanes                                                | suite completa e closeout bidirecional |

## Divergências deliberadas

- **D2 / L22:** `prompt.submit` com `sub_id` é recusado com JSON-RPC `-32602`,
  mensagem `subsession cannot be promoted to a gateway session` e causa de
  audit `SUBSESSION_PRIVILEGE_PROMOTION_DENIED`. Nenhuma sessão privilegiada ou
  toolset do pai é criado.
- **D3 / M4 e M4-bis:** colisões MCP sanitizadas falham com causa
  `MCP_TOOL_NAME_COLLISION`. `connectAll` reverte o lote inteiro; `refresh`
  preserva registry/client antigos e fecha transitórios.

## Dívidas e `NOT_MEASURED`

| Classificação  | Item                                                           | Disposição                                                               |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `NOT_MEASURED` | providers/SDKs/live smokes com credenciais                     | não inferir PASS; executar somente com autorização específica            |
| `NOT_MEASURED` | package/PTY em Windows nativo Node 20 e 22                     | bloqueia o PASS final T22 até existir runner offline preprovisionado     |
| `NOT_MEASURED` | macOS Node 20 se runner/cache nativo não estiver disponível    | bloqueia D16; Node 22 local não substitui                                |
| P2             | categorias Unicode não imprimíveis na emulação de `pythonRepr` | manter matriz bilateral/ADR; não alegar universalidade                   |
| P2             | metadata de owner de lock herdada em alguns wrappers           | não afeta exclusão/release; remover identidade fixa em manutenção futura |
| P2             | superfícies SDK reais e subscription streaming                 | permanecem fora dos gates offline                                        |

## Gate arquitetural decidido

O owner decidiu separadamente em 2026-09-03:

1. conteúdo: `typescript-mainline`;
2. preservação: registrar a decisão no novo arquivo versionado
   [gate-decision-t22.md](gate-decision-t22.md), sem ler, copiar ou sobrescrever
   o `docs/gate-decision.md` local protegido.

O SHA T22 não pode se autorreferenciar dentro do próprio commit. Por isso o
token `EVIDENCE_BOUND_FINAL_SHA` é deliberado: o SHA exato fica vinculado no
`.parity-evidence/t22/evidence-index.json` e no handoff externo, ambos gerados
depois que o commit é congelado.

## Interpretações do inventário fechado

- `parity` é metadado porque requer `--manifest`; executá-lo sem fixture não é
  um gate. `verify:t22:evidence` é o verificador pós-hoc e não roda
  recursivamente dentro do aggregate.
- `parity:t08` e `parity:t09` usam os respectivos runners `:all` como pais de
  cobertura mais fortes para o mesmo CLI estrutural.
- `parity:t22:update` e `probe:t22:update` compartilham um runner. O arquivo
  `update.json` separa as matrizes de status e os efeitos de argv/árvore Git.
- E22 é derivado de components vinculados ao SHA, rulings, provenance e
  aggregates; não é um PASS autoatribuído.
