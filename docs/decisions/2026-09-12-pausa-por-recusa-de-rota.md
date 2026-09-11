# Pausa por recusa de rota: `route_fault` com lição estruturada

- **Data:** 2026-09-12
- **Origem:** issue #426 (M10-S5, épico #421 "Supervisão em voo"); decisões 1
  e 4 do mapa do épico (comentário de #421); emenda do orquestrador de
  2026-09-12 no bloqueio de escopo levantado durante a implementação.

## Contexto

Antes desta issue, `nonCompleteFirstCollectResult` (`src/workflow/engine-utils.ts`)
era binário: `errorKind === quota_exhausted` pausava o run
(`noteQuotaExhausted`, cancela as folhas vivas); qualquer outro kind —
inclusive `auth_failed`, `route_fault` e `model_not_found`
(`src/transports/error-kinds.ts`, M8) — só entrava em `faults`/`faultKinds`
e o nó ficava nulo, com o run seguindo (`degraded` ou `failed`, nunca
pausado). Uma recusa de rota era indistinguível de uma recusa de conteúdo no
controle do run, e nenhuma lição estruturada chegava ao resume.

## Decisão

- **`auth_failed`/`route_fault`/`model_not_found` pausam o run** com
  `pause_reason: "route_fault"` — o 5º valor que `WorkflowEngine.pause` já
  seta (`checkpoint`, `quota_exhausted`, `token_budget_exhausted`,
  `user_requested` eram os quatro únicos até aqui; `audit-model.ts`'s
  allow-list `reason` ganha `route_fault` e o comentário "quatro" vira
  aberto para um quinto). `quota_exhausted` continua no caminho antigo,
  sem mudança.
- **A pausa carrega uma lição estruturada** — `{error_kind, node_id,
provider, model, suggested_route}` (`src/workflow/route-faults.ts`,
  `RouteLesson`) — no `pause_payload_json` durável (chave `lesson`,
  `pauseFields`/`durableRollup` em `service.ts`) e no `checkpoint` da view
  ao vivo (`resultView`, chave genérica que todo pause já usava).
  `provider`/`model` preferem o que a própria folha reportou
  (`ChildResult.provider`/`model`) e caem para a rota pedida pelo nó
  (`Routing`) quando a folha morreu antes de reportar.
- **`suggested_route` é sempre `null`** (decisão 4 do épico): pivotar de
  rota é um **resume manual** (`run_workflow(resume_run_id, route: {...})`,
  S6 — fora desta issue). Nenhum resolvedor de "rota de cobrança" (`routeFor`,
  `src/auth/credentials.ts`) está ligado ao engine nesta issue — "rota
  desconhecida" e "precisa de um humano" são o mesmo estado, por construção,
  não por omissão.
- **Um kind que pausa o run nunca entra em `faultKinds`/`fault_kinds_total`**
  (emenda 2026-09-12): a guarda que já excluía só `quota_exhausted`
  (`engine-utils.ts:487`, antes `:490`) foi generalizada para um predicado
  único, `pausesRun(kind)` (`route-faults.ts`) — a folha será re-executada
  no resume, e contá-la também em `fault_kinds` dobraria a cada retomada.
- **Sem prioridade entre razões de pausa.** Rota e quota usam o mesmo latch
  (`WorkflowEngine.pause`, `if (this.control.paused) return;`): o
  **primeiro nó que pausa vence**, na ordem de execução — não há
  desempate por tipo de causa.
- **Notice durável `kind = error_kind`** em `run:<runId>`
  (`recordRouteFaultNotice`, `route-faults.ts`) via um repositório de
  notices opcional (`OwnershipStore.notices`, `service.ts`) — sem
  reclassificação pelo `classify()` por substring de `notices-sink.ts`
  (fora dos `Files` desta issue). Sem repositório configurado, o checkpoint
  não é uma lição válida (`isRouteLesson`), ou a escrita for recusada ou
  lançar, cai em `this.warn` (via `appendSafe`) — nunca silencioso
  (invariante 2). **Rodada 2 (3ª emenda, PR #439 reprovada):** o revisor
  apontou que `productionOwnershipStore` — a única fábrica usada por
  `chat.ts`/`dashboard.ts` — não setava `notices`, então o AC nunca
  acontecia fora do harness de teste. Ligado pelo caminho de M8:
  `createSessionToolBase` expõe `noticesRepository` (a MESMA instância que
  `noticesSink`/`workflow_notices` já compartilham); `productionOwnershipStore`
  aceita `notices` como 7ª chave; `chat.ts`/`dashboard.ts` passam
  `notices: <toolBase>.noticesRepository`. Nenhuma issue de follow-up
  necessária — o notice agora acontece no processo real.

### O que esta pausa NÃO faz

- **Nenhum pivô automático de rota.** Decisão 4 do épico é explícita:
  `AutoResumeScheduler` continua só para quota, na mesma rota; um
  `route_fault` nunca reagenda sozinho.
- **Nenhuma re-key de célula.** A rota continua entrando no hash só dos nós
  que a declaram (`routingIdentity`, decisão 2 do épico, fora desta
  sub-issue) — resumir com outra rota (S6) não invalida células de nós sem
  pino.
- **Nenhum override de rota no resume ainda.** `run_workflow(resume_run_id,
route: {...})` é S6; até lá, resumir um run pausado por `route_fault`
  tenta a MESMA rota — se a causa (credencial, modelo) não mudou fora de
  banda, a folha se recusa de novo.

## Doutrina para autores de spec

Um `workflow_status` com `pause_reason: "route_fault"` significa que uma
folha recusou a ROTA em si (autenticação, o próprio roteamento do
provedor, ou um modelo inexistente) — não um problema de conteúdo do
prompt. A lição (`lesson`, ou `checkpoint` na view ao vivo) nomeia o nó, o
kind e a rota tentada; `suggested_route: null` é o estado normal hoje, não
uma falha do runtime — o operador decide manualmente qual rota tentar a
seguir.

## Evidência

- `tests/workflow-route-faults.test.ts`: os três kinds de rota pausam com
  `pause_reason: route_fault` e a lição esperada; `quota_exhausted` continua
  pausando sem mudança (contra-asserção); um kind que não é rota nem quota
  continua só em `faults`; rota e quota no mesmo run resolvem por ordem de
  execução; `workflow_status` durável expõe `lesson`; o notice durável
  carrega `kind = error_kind` escopado a `run:<runId>`; sem repositório
  configurado, o `warn` de fallback dispara.
- `tests/workflow-fault-kinds.test.ts`: os pinos que dependiam do
  comportamento anterior de `auth_failed` (um leaf isolado, e um leaf de
  rota ao lado de um de quota) foram atualizados para o novo `pause_reason:
route_fault` e para `faultKinds: []`.
- `npm run mutations:t15` (45/45): o mutante `Q1-quota-guard-removed`
  (`scripts/mutations/workflow-executor-mutants.ts`) foi re-ancorado na
  guarda generalizada (`!pausesRun(...)`), mesmo id, mesma fatia.
- Rodada 2: `productionOwnershipStore(db, { notices })` — o caminho real,
  não um store montado à mão — deixa o notice em `run:<runId>`, lido de
  volta por um `NoticesRepository.list` de verdade;
  `createSessionToolBase().noticesRepository` é o mesmo repositório que a
  tool `workflow_notices` lê (grava por ele, lê pela tool);
  `tests/workflow-audit-allow-list.test.ts` ganhou o oráculo que faltava
  para `route_fault` em `SAFE_STRING_VALUES.reason`.
