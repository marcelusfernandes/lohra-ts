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

## S6 (issue #427): override manual; chave conservadora

`run_workflow(resume_run_id, route: {provider?, model?})` (M10-S6, épico
#421) é o pivô manual que a seção anterior deixava para depois — o operador
(ou o agente que leu a lição) decide a rota nova; nada aqui a sugere.

- **A espec é reescrita ANTES do engine rodar**, não `routingOf`/
  `routingIdentity` (`engine-utils.ts`) threadados por `route`:
  `route-override.ts` (novo) reescreve `provider`/`model` em todo nó (e
  stage de `pipeline`) que já declara `model`/`tier`/`effort`/`provider` —
  o MESMO guard que `routingIdentity` usa para decidir se a rota entra no
  hash da célula. Um nó que nunca declarou rota nenhuma nunca é tocado.
  Consequência: **zero mudança** em `engine.ts`/`engine-utils.ts` (e no
  âncora de mutação `hash-remove-routing`,
  `scripts/mutations/workflow-executor-mutants.ts`) — cada função de
  cache-identity (`routingIdentity`, `loopCellParts`,
  `replayOrCollectBranch`, `recordGroupReplayCost`) re-keya sozinha, porque
  o campo que ela lê (`node.fields.provider`/`model`) já mudou antes dela
  rodar.
- **Chave conservadora confirmada**: a rota continua entrando no hash só
  dos nós que a declaram (decisão 2 do épico #421, S5) — resumir com outra
  rota invalida a célula de um nó PINADO (ele re-executa na rota nova) e
  preserva a célula de um nó sem pino (replay do cache, `cache.replayed`).
  Nenhuma re-key global foi cogitada nesta issue; a alternativa do
  enunciado da milestone (tirar a rota da chave) segue rejeitada.
- **O pivô PERSISTE no `spec_json`**: `service.ts` grava a espec já
  reescrita (`rawSpecOf(parsed)`) a cada escrita terminal — um resume
  POSTERIOR sem `route` continua na rota nova, não volta para a original.
  `pause_payload_json.pivots[]` é o único registro de que a rota mudou —
  cada entrada é o `RouteOverride` APLICADO (o `route` que o resume pediu,
  ex.: `{provider, model}`), nunca a rota que estava em vigor antes dele
  (`nextPivots`, `route-override.ts:143-146`, só concatena o `override`
  recebido ao array anterior); não há registro nenhum, em lugar algum, de
  qual era a rota antes de cada pivô, nem uma cópia da espec "como
  autorada".
- **Teto de `MAX_ROUTE_PIVOTS_PER_RUN` (3) por run** (`pivotResume`,
  route-override.ts): acima do teto, o resume é recusado com um erro
  nomeado — um gate humano de facto, coerente com a decisão 4 do épico
  #421 (pivô é sempre manual; `AutoResumeScheduler` continua rearmando só
  quota, na mesma rota, sem tocar `route` nunca). `pivots` viaja dobrado
  para frente em `pause_payload_json` a cada escrita terminal, exatamente
  como `prior_faults`/`prior_fault_kinds` já viajavam — omitido (nunca uma
  lista vazia) para um run que nunca pivotou, para que o payload de todo
  run anterior a esta issue continue byte-idêntico. Exposto em
  `workflow_status` via `durableRollup` quando não vazio (uma leitura
  DURÁVEL — `resultView`, o envelope de um run ainda vivo NESTE processo,
  não ganhou o campo; fora do escopo desta issue, `service-rollup.ts` não
  está nos `Files`).
- **`pipeline` stage**: uma `stage` que nomeia sua própria rota (a exceção
  documentada em `run_workflow`) SOMBREIA o pivô do nó por inteiro —
  `route-override.ts` reescreve a stage também, não só o nó, ou ela
  continua recusando na rota velha.
- **`engine.ts`/`engine-utils.ts` intocados; `service.ts` sem crescimento**
  (teto de 1296 linhas, zero de folga): o fechamento `pause_payload_json`
  que já existia em `launchDurable` (`priorFaults`/`priorDegraded` mais o
  `JSON.stringify` inline) foi consolidado num só builder
  (`pausePayloadOf`, route-override.ts) — abriu espaço para o campo
  `pivots` novo sem crescer o arquivo (1296 → 1292 linhas).
- **Sub-workflow por `ref` — fechado pelo #452.** Esta nota listava o gap
  original ("O que esta issue NÃO faz"): `route-override.ts` só reescrevia a
  espec de nível superior; `runNested` (`engine.ts`) carrega o template do
  `ref` em runtime, depois de `pivotResume` já ter rodado, então o pivô do
  run pai nunca alcançava a rota de um nó dentro do template referenciado.
  O #452 fecha isso com `overrideNestedSpec` (`route-override.ts`),
  aplicado dentro de `runNested` com o `routeOverride` do próprio engine
  (novo campo em `WorkflowEngineOptions`) — profundidade continua limitada a
  `MAX_WORKFLOW_DEPTH = 1`, então só o run pai (nunca um nested) carrega
  outro template.

### O que esta issue NÃO faz

- **Nenhuma rota pré-autorizada nem `node.rerouted`** — fora de escopo
  (M11, conforme o épico).
- **Nenhum pivô automático** — decisão 4 do épico continua valendo; só um
  `run_workflow(resume_run_id, route: {...})` explícito pivota.
- **Nenhuma tool `workflow resume` de CLI** — fora do escopo desta issue.
- **Cada resume com `route` consome um dos 3 pivôs, mesmo que não resolva o
  problema.** `nextPivots` empilha o `override` toda vez que `pivotResume`
  aceita um (`route-override.ts:143-146,158-177`) — se a folha se recusar de
  novo na rota nova (credencial ainda errada, modelo ainda inexistente), a
  PRÓXIMA tentativa de pivô já é a 2ª de 3, não uma repetição da mesma
  tentativa; só um resume RECUSADO por já ter atingido o teto (ou por faltar
  `resume_run_id`) não consome pivô nenhum.

### Evidência

- `tests/workflow-route-override.test.ts`: nó sem pino replayado
  (`cache.replayed`) e nó pinado recomputado (`cache.missed`/
  `cache.stored`) na rota nova, num run durável de verdade; `route` sem
  `resume_run_id` ou malformado recusado com erro nomeado; teto de 3
  pivôs por run, com um 4º resume recusado citando o teto; `pivots`
  exposto em `workflow_status`; os exports de `route-override.ts`
  (`applyRouteOverride`, `overrideNode`, `pivotResume`, `nextPivots`,
  `pivotsOf`) exercitados diretamente.
- `npm run mutations:t15` (45/45), `t16` (60/60), `t17` (57/57) — nenhuma
  fatia precisou de re-ancoragem (nem `engine.ts`, `engine-utils.ts` nem
  `service.ts` mudaram de forma reconhecível pelos mutantes existentes).
- Dogfooding real (`node dist/cli.js chat --json --yolo`, uma
  `OPENROUTER_API_KEY` inválida escopada só a este processo — nunca lida
  nem escrita em `~/.lohra/**`): um `run_workflow` roteado para
  `provider: "openrouter"` com um modelo inexistente pausa
  `route_fault`/`auth_failed`; o próprio agente chama `list_models`,
  escolhe `provider: "anthropic"` com um modelo real, e
  `run_workflow(resume_run_id=..., route={...})` completa o nó
  (`outputs.a: "ok"`) na rota nova — `exit_code=0`, `error: null`,
  `completed: true`, 9 `tool_calls`.
