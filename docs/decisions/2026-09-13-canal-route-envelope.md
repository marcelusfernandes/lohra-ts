# Canal do pivô de rota: `route_envelope` aplica sozinho, `operator` sempre vence

- **Data:** 2026-09-13
- **Origem:** issue #460 (M11-S2, épico #458 "Rotas, cache e artefatos");
  mapa do épico #458 (comentário, 2026-09-12), decisões 1(b) (resume sem
  `route` aplica `suggested_route` automaticamente), 2 (`AutoResumeScheduler`
  não re-arma `route_fault`) e 9 (teto único de 3 pivôs para os dois
  canais); `docs/decisions/2026-09-13-envelope-de-rotas.md` (#459, S1 —
  só a metade "preencher `suggested_route`").

## Contexto

Desde #459, `withSuggestedRoute` (`route-faults.ts`) preenche
`RouteLesson.suggested_route` a partir de `workflow_routes.json`, mas
"decisão 1, só a metade preencher" deixava explícito: nada resumia sozinho —
um resume sempre precisava de um `route` explícito
(`run_workflow(resume_run_id=..., route={provider?, model?})`). O critério
de saída da milestone ("o harness nunca escolhe fora da lista") ficava
parcialmente satisfeito: o operador já podia autorizar rotas alternativas,
mas nada as consumia automaticamente, e uma troca de rota (por qualquer
canal) não deixava rastro no ledger — `pivots[]` guardava só
`{provider?, model?}`, sem dizer QUEM pediu o pivô.

## Decisão

- **Um resume SEM `route` explícito de um run pausado `route_fault` aplica
  `suggested_route` do envelope automaticamente** (`pivotResume`,
  `route-override.ts`) — canal `"route_envelope"` — sujeito à MESMA condição
  de quatro partes, cada uma testada por negação em
  `tests/workflow-rerouted.test.ts`: (1) a pausa É `route_fault`; (2) o
  `checkpoint` É uma `RouteLesson` (`isRouteLesson`) com `suggested_route`
  não-nulo; (3) o resume NÃO nomeia `route`; (4) o run ainda não pivotou
  `MAX_ROUTE_PIVOTS_PER_RUN` (3) vezes. A negação de qualquer uma delas
  devolve o spec intocado, por referência (`rerouted: []`, nenhum
  `node.rerouted`).
- **`route` explícito continua livre e sempre vence** — canal `"operator"`
  (o mesmo comportamento de #427, só rotulado): mesmo com um
  `suggested_route` disponível, um `route` passado pelo agente/operador é o
  que se aplica; o envelope restringe apenas o que o HARNESS escolhe
  sozinho, nunca o que uma pessoa (ou o agente agindo por ela) pede
  explicitamente.
- **Teto único de 3, compartilhado pelos dois canais** (decisão 9): cada
  pivô — `operator` ou `route_envelope` — consome uma das 3 vagas de
  `MAX_ROUTE_PIVOTS_PER_RUN`. No teto, os dois canais se comportam
  DIFERENTE por design: um `route` explícito continua recusado com o erro
  nomeado de #427 (`"already pivoted route 3 times"`); um resume SEM
  `route` no teto NUNCA é recusado — o operador não pediu pivô nenhum, e
  recusar bloquearia um resume legítimo — ele apenas segue na rota atual,
  sem consumir pivô e sem `node.rerouted`. Testado com os dois canais no
  mesmo run: 2 pivôs `operator` + 1 `route_envelope` = 3; o 4º `route`
  explícito é recusado; um resume sem `route` depois disso fica parado, mesmo
  com uma sugestão ainda configurada para a rota morta atual.
- **`pivots[i].channel` é aditivo e durável** — `RouteOverride` ganha
  `channel?: "operator" | "route_envelope"`; um pivô gravado antes desta
  issue (sem `channel`) continua válido (`isRouteOverride` só valida o
  valor QUANDO presente); round-trip completo por `pivotsOf`.
- **`node.rerouted` é um evento por NÓ reescrito**, nunca por pivô — um
  pivô que reescreve dois nós grava dois eventos, um pivô que não reescreve
  nenhum (rota nunca declarada por nenhum nó) não grava nada. Emitido no
  segmento NOVO, logo depois de `workflow.plan` (`announceStretchStart` →
  `announceRerouted`, `service.ts`/`audit-producers.ts`) — nunca antes do
  plano, nunca no segmento anterior. `from`/`to` são a routing REAL do nó
  (`routingOf`, `engine-utils.ts`) antes/depois do pivô — um nó que só
  declara `tier` (sem `provider`/`model` explícitos) reporta o par
  resolvido pelo mapa de tiers no "antes", não campos brutos ausentes. Uma
  reescrita só de STAGE de `pipeline` (nunca do próprio nó) ainda gera um
  registro, atribuído ao id do NÓ pai (nunca um sub-id de stage) — `from`/
  `to` nesse caso refletem a routing do nó (sem stage), já que o engine
  resolve a routing de cada stage independentemente em tempo de execução
  (`runPipeline`, fora do alcance desta issue).
- **Forma do payload de `node.rerouted`**: `channel`/`pivot` são
  `IDENTITY_FIELDS`/`NUMBER_FIELDS` de sempre; `from`/`to` são OBJETOS
  aninhados `{provider, model}` sob `CONTAINER_FIELDS` (não uma forma
  achatada `from_provider`/`from_model`) — decisão do §Solução item 3 da
  issue #460: `provider`/`model` dentro de `from`/`to` já passam por
  `IDENTITY_FIELDS` (clip 128) sem precisar de allow-list nova, e o formato
  aninhado é o que a descrição de `workflow_audit` e o resto do ledger já
  usam para pares relacionados (ex. `budget {total, spent, remaining}`).

## O que esta issue NÃO faz

- **`AutoResumeScheduler` não re-arma `route_fault`** (decisão 2, intacta
  desde #421/#426): o agendador continua só para `quota_exhausted`. Um
  `route_fault` nunca resume sozinho, por nenhum canal — só um
  `run_workflow(resume_run_id=...)` explícito (com ou sem `route`) decide
  quando pivotar.
- **`max_fallbacks_per_run`** ou qualquer teto novo — decisão 9,
  `MAX_ROUTE_PIVOTS_PER_RUN` continua o único, agora compartilhado.
- **Pivô alcançando um sub-workflow por `ref`** — já resolvido por #452
  (`overrideNestedSpec`), fora do escopo desta issue.
- **`routeFaultNotice`** (`route-faults.ts`, fora dos `Files`) — o texto do
  notice não muda; ele continua dizendo "resume with run_workflow(...,
  route={...})" como uma opção, não a única.

## Evidência

- `tests/workflow-rerouted.test.ts` (novo): as quatro negações da conjunção
  isoladas; o caso positivo completo (tier → envelope → sucesso,
  `node.rerouted` só no nó pinado, round-trip de `channel` via `pivotsOf`);
  `route` explícito vencendo a sugestão do envelope; teto compartilhado com
  os dois canais e o comportamento assimétrico no teto (explícito recusado,
  sem-rota parado); contra-asserção de payload byte-idêntico para um run
  sem pivô.
- `tests/workflow-audit-allow-list.test.ts`: oráculo positivo/negativo de
  `channel`, `pivot`, `from`/`to` (clip 128), e `node.rerouted` como
  `event_type` válido.
- `tests/workflow-route-override.test.ts`: pinos existentes (`pivots[]` sem
  `channel`) atualizados para incluir `channel: "operator"` num `route`
  explícito — comportamento aditivo, nunca removido.
- `npm run mutations:t15`/`t16`/`t17`/`mutations:supervision` — pendentes
  nesta rodada: três pinos fora dos `Files` desta issue
  (`tests/workflow-cache-preview.test.ts:310`,
  `tests/workflow-route-override-nested.test.ts:224`,
  `tests/workflow-routes.test.ts:709`) quebram pela mesma razão aditiva
  (`channel: "operator"` num `route` explícito) e bloqueiam o baseline das
  fatias até a emenda do orquestrador incluí-los.
