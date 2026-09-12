# Envelope de rotas do operador: `suggested_route` deixa de ser sempre `null`

- **Data:** 2026-09-13
- **Origem:** issue #459 (M11-S1, épico #458 "Rotas, cache e artefatos");
  mapa do épico #458 (comentário, 2026-09-12), decisões 1 (só a metade
  "preencher `suggested_route`"), 4 (`workflow_routes.json` inválido recusa
  o launch, como `readTiers` → `TiersError`) e 9 (sem
  `max_fallbacks_per_run`; teto único `MAX_ROUTE_PIVOTS_PER_RUN` = 3).

## Contexto

Desde #426 (`docs/decisions/2026-09-12-pausa-por-recusa-de-rota.md`), um
`route_fault` pausa o run com uma lição estruturada
(`RouteLesson`, `src/workflow/route-faults.ts`) cujo `suggested_route` era o
tipo literal `null` — decisão 4 do épico #421 dizia "nenhum resolvedor de
rota ligado ao engine nesta issue", e "rota desconhecida" e "precisa de um
humano" eram o mesmo estado por construção. O operador não tinha onde
autorizar rotas alternativas para uma rota que já se recusou antes, e o
agente escolhia a rota do pivô sem nenhuma base.

## Decisão

- **`workflow_routes.json` é um arquivo do operador**, lido por lançamento
  (molde `workflow_tiers.json`/`readTiers`, #234): `{"routes": {"<provider
morta>/<model morto>": [{"provider", "model"}, ...]}}`, uma lista ORDENADA
  de fallbacks por rota morta. `readRoutes` (`src/workflow/routes.ts`, novo)
  é fail-closed — arquivo ausente é `{routes: {}}` legítimo; JSON inválido,
  raiz não-objeto, chave de topo diferente de `routes`, chave de rota sem
  exatamente um `/`, fallback sem `provider`/`model` não vazios, fallback
  com campo desconhecido, fallback igual à própria rota morta, ou lista
  vazia são um `RoutesError` nomeado citando o caminho. `WorkflowService.start`
  recusa o launch nesse erro, exatamente como `TiersError` — **decisão 4**:
  um arquivo quebrado é erro do operador, nunca um estado silencioso.
- **`suggestRoute` é pura**: dado a lição (`provider`/`model` da rota morta),
  o envelope e as rotas já tentadas NESTE run (`pivots`), devolve o primeiro
  fallback da lista que não está em `tried` — `null` sem lição de rota, sem
  entrada no envelope, ou lista esgotada. Nunca lê disco, nunca toca o
  engine.
- **`withSuggestedRoute` enriquece a lição no terminal do service**
  (`src/workflow/service.ts`, os dois pontos onde `record.result` é
  atribuído) — ANTES de qualquer leitor: `workflow_status` durável
  (`durableRollup`'s `lesson`), a view ao vivo (`checkpoint`),
  `pause_payload_json.checkpoint`, e a mensagem do notice
  (`routeFaultNotice`, agora com `suggested=<provider>/<model>` ou
  `suggested=none`) — as quatro leem o MESMO objeto, mutado uma vez só, no
  mesmo padrão que `sealRunStatus` já usa para `result.checkpoint`. Um
  resultado que não é `route_fault` (ou cujo `checkpoint` não é uma
  `RouteLesson`) é devolvido intocado, por referência — contra-asserção
  coberta em teste.
- **`isRouteLesson` aceita as duas formas de `suggested_route`**: `null`
  (o estado padrão, sem envelope) ou `{provider: string, model: string}` (a
  sugestão preenchida) — nunca uma string solta nem um objeto parcial.
- **Só a metade "preencher" desta decisão** (decisão 1 do mapa do épico):
  `suggested_route` é um HINT — nada resume sozinho. Um resume ainda precisa
  de um `route` explícito (`run_workflow(resume_run_id=..., route={...})`);
  aplicar a sugestão automaticamente quando o resume não nomeia `route` é
  **S2 (#460)**, fora desta issue.
- **Sem `max_fallbacks_per_run`** (decisão 9): o único teto continua
  `MAX_ROUTE_PIVOTS_PER_RUN = 3` (`route-override.ts`) — o envelope pode
  listar quantos fallbacks o operador quiser; o que limita quantas vezes um
  run pivota é o teto que já existia, não o tamanho da lista.

### Por que o comentário de #426 ficou desatualizado

O comentário original de `route-faults.ts` (linhas 12-16, issue #426) dizia
"`suggested_route` is always `null` here" como uma decisão permanente — era,
na verdade, o escopo de UMA sub-issue (S5, #426), não do domínio inteiro. O
comentário foi reescrito para apontar para esta issue (#459) e deixar claro
que decisão 4 (pivô sempre manual) continua valendo — só a ORIGEM da
sugestão mudou, não a exigência de um `route` explícito.

## Doutrina para autores de spec

`lesson.suggested_route` (ou `null`) é informação, não uma escolha
automática — o mesmo espírito de `list_models` (CLAUDE.md: "o catálogo é
informação, não um allow-list"). Um agente que lê um `workflow_status`
pausado por `route_fault` pode usar a sugestão como está, escolher outra
rota, ou ignorá-la — mas sempre precisa passar `route={provider?, model?}`
explicitamente no resume. O envelope nunca é consultado por
`AutoResumeScheduler` (esse continua só para quota, decisão 4 do épico
#421, intacta).

## O que esta issue NÃO faz

- **Aplicar a sugestão automaticamente num resume sem `route`** — é S2
  (#460): `channel: "route_envelope"`, `pivots[i].channel`, evento
  `node.rerouted`.
- **`max_fallbacks_per_run`** ou qualquer outro teto novo — decisão 9,
  `MAX_ROUTE_PIVOTS_PER_RUN` continua o único.
- **CLI `lohra routes`**, **`list_models` reportando o envelope**, ou
  validar `provider` contra `getProviderProfile` — fora de escopo,
  conforme a issue.
- **Curinga `"<provider>/*"`** na chave de rota morta — cada entrada nomeia
  a rota morta exata.

## Evidência

- `tests/workflow-routes.test.ts` (novo): `readRoutes` fail-closed (uma
  forma inválida por `it`, molde `tests/workflow-tiers.test.ts`);
  `WorkflowService.start` recusando um `workflow_routes.json` inválido;
  `suggestRoute` pura (primeiro fallback não tentado, exclui a rota morta,
  `null` nos três casos degenerados); `isRouteLesson` aceitando as duas
  formas e recusando uma string; `withSuggestedRoute` enriquecendo a lição
  e deixando um resultado sem `route_fault` intocado (contra-asserção);
  round-trip completo por `WorkflowService` real — `workflow_status`
  durável, `pause_payload_json.checkpoint` e a mensagem do notice trazem a
  MESMA sugestão; sem envelope, o comportamento é byte-idêntico a antes
  desta issue.
- `tests/workflow-route-faults.test.ts`: nenhum pino mudou — todo cenário
  ali continua sem `workflow_routes.json`, então `suggested_route: null`
  continua a asserção certa.
- `npm run mutations:t15` (45/45), `t16` (60/60), `mutations:supervision`
  (20/20) — `R3-is-route-lesson-always-true`
  (`scripts/mutations/supervision-mutants.ts`) re-ancorado na nova cláusula
  de `isRouteLesson` (aceitar `Route | null`, não só `=== null`).
