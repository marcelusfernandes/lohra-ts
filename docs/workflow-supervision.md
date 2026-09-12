# Supervisão em voo: `workflow_steer`, `workflow_leaf_read`, pivô de rota

Épico #421 (M10 "Supervisão em voo"), dez sub-issues mergeadas em
`main` — três ferramentas/capacidades que deixam um operador (ou o próprio
agente que orquestra) intervir num `run_workflow` já em execução, sem
esperar ele falhar ou pausar sozinho. A M10 foi seguida pela milestone 14
de consertos pós-revisão (#440, #444–#452, #457), que corrigiu achados dos
revisores sem mudar a forma das três capacidades, e pela milestone 11 "Rotas,
cache e artefatos" (épico #458, #459-#464), que estendeu o pivô de rota com
um envelope pré-autorizado pelo operador e um canal automático, acrescentou
`workflow_preview` (dry-run de resume) e o manifesto de artefatos por run, e
ligou em produção o loader de templates que o pivô de sub-workflow (S6 do
M10) já preparava. Este documento é o resumo operacional; o comportamento
medido e a doutrina de cada decisão estão nas notas em `docs/decisions/`
linkadas abaixo, e o vocabulário do ledger (`leaf.steered`, o 5º
`pause_reason`, `node.rerouted`, `cache.missed`/`cache.replayed`) está em
[`docs/workflow-audit.md`](workflow-audit.md).

## `workflow_steer` — mensagem ao vivo para um leaf em execução (#424, M10-S3)

Entrega uma mensagem de operador ao próximo turno de um leaf que já está
rodando, sem esperar ele falhar ou fazer uma pergunta. Nomeia o leaf com
EXATAMENTE UM de `node_id` (resolvido contra os leaves vivos do run agora —
nunca um já terminado) ou `sub_id` (de um evento `leaf.started` em
`workflow_audit`, para desambiguar um fan-out com mais de um leaf vivo no
mesmo nó). `run_id` inexistente, `node_id` sem leaf vivo, `sub_id` que não é
leaf vivo deste run, `node_id` ambíguo (mais de um leaf vivo no mesmo nó),
**janela de resolução truncada** (resolver um `node_id` pagina o ledger até
`has_more: false`, com teto em `MAX_RESOLUTION_EVENTS = 2_000` — acima
disso, erro nomeado "window truncated" em vez de um falso "sem leaf vivo";
`sub_id` resolve por um filtro EXATO no ledger e nunca lê essa janela,
imune ao teto; #445), ou **o runtime do run não expor `steerOutcome`**
(todo `ChildRuntime` anterior a `OrchestrationChildRuntime`, ou um double
de teste que só implementa `steer`; #450) voltam como erro nomeado, nunca um
no-op silencioso (`src/workflow/steer-tool.ts:245-251,253-277,307-308,310`).
A janela de resolução (`pagedSubIds`) também falha fechado quando o próprio
repositório devolve uma página que se diz incompleta (`has_more: true`) mas
não avança `next_after_seq` — `truncated: true`, nunca "sem leaf vivo" para
uma leitura que não terminou (#477).

- **Teto por leaf**: `MAX_PENDING_STEERS_PER_LEAF = 10`
  (`src/orchestration/core.ts:26`) — acima disso, `core.steer` recusa com
  `refused: "steer_cap"` em vez de enfileirar mais um texto que o leaf talvez
  nunca leia (`core.ts:320-326`); `workflow_steer` traduz isso num erro
  nomeado citando o teto (`steer-tool.ts:63,313`).
- **A mensagem nunca vai ao ledger** — só o tamanho: `leaf.steered`
  (`docs/workflow-audit.md`) carrega `payload.message_chars`, nunca o texto
  (`audit-runtime.ts:344-353`, dentro de `deliverSteer`,
  `audit-runtime.ts:332-356`). `payload.source` é `"operator"` para todo
  steer que passa por esta tool (`steer-tool.ts:310`, 4º argumento de
  `runtime.steerOutcome`) — distinto de `"engine"`, o steer interno de
  retry de schema (`engine.ts:296-312`). **`leaf.steered` só é gravado
  quando o core aceita o steer** (#444) — `queued: true` (enfileirado) ou
  a ressurreição `{queued: false}` sem `refused` (novo turno, inclusive o
  retry de schema pós-terminal acima); nunca para `refused: "steer_cap"`
  nem para um `sub_id` terminal/desconhecido (`outcome === null`) —
  `audit-runtime.ts:344` (`outcome.refused === undefined`) é a guarda.
- Resolve a identidade causal do leaf com `runtime.causalSnapshot`
  (`orchestration-runtime.ts:226`, exposto por `AuditedChildRuntime` desde
  #422/M10-S1) — sem isso, não haveria como gravar `leaf.steered` com a
  identidade certa para um steer que chega de fora do engine.

## `workflow_leaf_read` — ler os turnos já assentados de um leaf vivo (#425, M10-S4)

Lê os turnos que um leaf ainda rodando já COMMITOU — nunca o turno em voo,
que só é gravado ao final (`conversation/runtime.ts:578-586`, comentário em
`src/workflow/leaf-read-tool.ts:8-11`). Ao contrário de `workflow_audit`,
**não é metadata-only**: o conteúdo de um turno `tool` é a saída bruta e
não redigida que o leaf realmente viu.

- **Orçamento de caracteres compartilhado**: `max_chars` (padrão 4096,
  máximo 32768 — `DEFAULT_MAX_CHARS`/`MAX_MAX_CHARS`,
  `leaf-read-tool.ts:47-48`) é gasto do turno MAIS RECENTE para o mais
  antigo (`truncateTurns`, `leaf-read-tool.ts:110-142`) — a cauda da
  conversa nunca é cortada por causa de turnos antigos; são os turnos mais
  ANTIGOS que voltam com `content: ""` quando o orçamento acaba, e o turno
  mais recente ainda é fatiado se ele sozinho estourar o orçamento inteiro.
- **Só os 200 turnos mais recentes**: `MAX_TURNS = 200`
  (`leaf-read-tool.ts:57`) — um teto nomeado, não uma paginação; turnos
  mais antigos que isso nunca voltam, e `truncated_turns` avisa quando foi
  o caso.
- **Checagem de posse fail-closed**: `sub_id` precisa pertencer a `run_id` —
  verificado por um `leaf.started` na auditoria daquele run
  (`leaf-read-tool.ts:163-170`). Se a trilha de auditoria estiver desligada
  (`LOHRA_AUDIT=off`), a fila tiver descartado o evento, ou a retenção já
  tiver podado o run, esta tool devolve o MESMO erro nomeado de um `sub_id`
  de outro run — nunca confia numa alegação não verificável (invariante 2).
  **Consequência prática**: com a auditoria desligada, `workflow_leaf_read`
  fica inutilizável para qualquer leaf, mesmo real.

## Pivô de rota: `run_workflow(resume_run_id=..., route={provider?, model?})` (#426/#427, M10-S5/S6; #459/#460, M11-S1/S2)

Um run pausado com `pause_reason: "route_fault"` (5º valor — auth/roteamento/
modelo recusou um leaf, nunca quota; ver
[`docs/decisions/2026-09-12-pausa-por-recusa-de-rota.md`](decisions/2026-09-12-pausa-por-recusa-de-rota.md))
carrega uma lição estruturada (`lesson`) e pode ser retomado numa rota
DIFERENTE — por um `route` explícito ou, desde a M11, pela sugestão do
envelope do operador aplicada automaticamente:

- `route` só é aceito junto de `resume_run_id`; reescreve `provider`/`model`
  em todo nó (e stage de `pipeline`) da espec PERSISTIDA do run que já
  declara uma rota — um nó que nunca declarou rota nenhuma nunca é tocado.
  Um `provider`/`model` fornecido precisa ser não-vazio depois de `trim` —
  string vazia ou só espaço é recusada com erro nomeado ANTES de tocar o
  run (nenhuma escrita, nenhum pivô consumido; #447,
  `src/workflow/tool.ts:88-91`).
- **Chave de cache conservadora**: um nó PINADO (que declara rota) recomputa
  na rota nova; um nó sem pino continua replayando do cache
  (`cache.replayed`) — o pivô nunca invalida trabalho que não dependia de
  rota.
- **O pivô PERSISTE**: a espec reescrita é gravada de volta no `spec_json`
  a cada escrita terminal — um resume posterior sem `route` continua na
  rota nova.
- **`pivots` aparece nos dois envelopes** — no durável (`workflow_status`
  via `durableRollup`) e, desde o #448, também em `resultView`/
  `runningView` (`service-rollup.ts`, o run ainda vivo NESTE processo) —
  chave omitida (nunca lista vazia) para um run que nunca pivotou, nos
  dois caminhos.
- **Teto de 3 pivôs por run, COMPARTILHADO pelos dois canais** (abaixo)
  (`MAX_ROUTE_PIVOTS_PER_RUN`, `src/workflow/route-override.ts:25`) — cada
  resume que pivota, por qualquer canal, consome um, mesmo que a folha se
  recuse de novo na rota nova; o 4º `route` explícito é recusado com erro
  nomeado, um gate humano de facto — um resume SEM `route` no teto nunca é
  recusado, só fica na rota atual sem consumir pivô. O teto sobrevive a
  um crash do processo (#446) — as duas escritas que antes zeravam
  `pivots` num crash a meio do stretch agora carregam o valor prévio
  adiante (`registrationPayload`, `route-override.ts:366-372`).

### Envelope do operador: `workflow_routes.json` e o canal automático (#459/#460, M11-S1/S2)

Antes da M11, `lesson.suggested_route` era sempre `null` — pivotar exigia um
`route` explícito, sempre. Desde #459/#460, o operador pode PRÉ-AUTORIZAR
fallbacks para uma rota morta específica, e um resume sem `route` os
consome sozinho:

- **`workflow_routes.json`** (`<home>/workflow_routes.json`, molde
  `workflow_tiers.json`/`readTiers`, #234): `{"routes": {"<provider
morta>/<model morto>": [{"provider", "model"}, ...]}}`, uma lista ORDENADA
  de fallbacks por rota morta. `readRoutes` (`src/workflow/routes.ts`) é
  **fail-closed** — arquivo ausente é `{routes: {}}` legítimo; JSON
  inválido, raiz não-objeto, chave de topo diferente de `routes`, chave de
  rota sem exatamente um `/`, fallback sem `provider`/`model` não vazios,
  fallback com campo desconhecido, fallback igual à própria rota morta, ou
  lista vazia são um `RoutesError` nomeado — `WorkflowService.start` recusa
  o LANÇAMENTO nesse erro, exatamente como um `workflow_tiers.json`
  quebrado (`service.ts:494`). Sem `max_fallbacks_per_run`: o único teto
  continua o de 3 pivôs acima.
- **`lesson.suggested_route`** deixa de ser sempre `null`: `withSuggestedRoute`
  (`route-faults.ts`) preenche o primeiro fallback do envelope que este run
  ainda não tentou (`suggestRoute`, `routes.ts`, pura — nunca lê disco nem
  toca o engine), no `checkpoint`/`pause_payload_json.lesson` e na mensagem
  do notice (`suggested=<provider>/<model>` ou `suggested=none`). Continua
  um HINT, nunca uma escolha automática por si só — só preencher não pivota
  nada (decisão 1(a) do mapa do épico #458).
- **Canal automático**: um resume SEM `route` explícito de um run pausado
  `route_fault`, com `suggested_route` não-nulo e o teto de 3 ainda não
  atingido, aplica a sugestão sozinho — `pivots[i].channel: "route_envelope"`
  (`pivotResume`, `route-override.ts`). Um `route` explícito continua
  livre e **sempre vence**, mesmo quando difere da sugestão —
  `channel: "operator"` — porque o envelope restringe o que o HARNESS
  escolhe sozinho, nunca o que o operador (ou o agente por ele) pede
  explicitamente. `AutoResumeScheduler` **não** re-arma `route_fault` por
  nenhum canal — continua só para `quota_exhausted` (decisão 2 do épico
  #421, intacta).
- **`node.rerouted`** — um evento por nó que o pivô efetivamente reescreveu
  (`channel`, `pivot`, `from`/`to`), no segmento novo, depois de
  `workflow.plan`; vocabulário completo em
  [`docs/workflow-audit.md`](workflow-audit.md).
- Detalhe, doutrina e evidência em
  [`docs/decisions/2026-09-13-envelope-de-rotas.md`](decisions/2026-09-13-envelope-de-rotas.md)
  (S1) e
  [`docs/decisions/2026-09-13-canal-route-envelope.md`](decisions/2026-09-13-canal-route-envelope.md)
  (S2).
- **Sub-workflow por `ref` também recebe o pivô, desde o #452.**
  `runNested` (`src/workflow/engine.ts`) carrega o template do `ref` em
  runtime, depois que `pivotResume` já reescreveu a espec do run pai;
  `overrideNestedSpec` (`route-override.ts`) aplica o MESMO
  `routeOverride` do run pai dentro de `runNested`, threadado por
  `service.ts` (`launch`/`launchDurable`) via
  `WorkflowEngineOptions.routeOverride`. Profundidade continua limitada a
  `MAX_WORKFLOW_DEPTH = 1` — só o run pai carrega outro template. **Desde
  o #464 (M11-S6), o mecanismo é alcançável em produção**: `chat.ts`/
  `dashboard.ts` passam `loader: templateLoader(options.home)` a
  `WorkflowService` — a ressalva que valia até aqui (loader só injetado à
  mão em teste) não vale mais; `runNested` só lança `"workflow loader
unavailable"` (`engine.ts:837`) quando o composition root de fato não
  configurou um (nunca o caso de `chat`/`dashboard`).

Detalhe completo (o que cada pivô registra, o que fica de fora, a decisão
de não fazer re-key global) na nota de decisão linkada acima.

## `cache.missed`/`cache.replayed`: o que o operador lê num pivô (#461, M11-S3)

Duas leituras que `workflow_audit`/`lohra workflow watch --events` já
mostram e que um pivô de rota torna relevantes:

- **`cache.missed {reason}`** — por que um nó recomputou em vez de
  replayar: `never_completed` (este nó nunca teve célula, sob NENHUM hash —
  primeira execução real) ou `identity_changed` (já teve, sob um hash
  DIFERENTE — a identidade da célula mudou, tipicamente porque um pivô de
  rota reescreveu o nó). Omitido (nunca `null`) quando o chamador não
  nomeou um `nodeId`.
- **`cache.replayed {version_state}`** — proveniência do HIT, nunca um
  aviso de dado suspeito: `current` (o carimbo bate com a versão de hoje),
  `stale` (carimbo presente mas de uma versão ANTERIOR — a mecânica de hash
  mudou desde que a célula foi escrita) ou `unstamped` (célula de um banco
  anterior à coluna `identity_version` existir). O replay em si acontece
  IGUAL nos três casos — só a classificação muda; um `stale` depois de um
  pivô de rota é o estado ESPERADO, não uma corrupção. Detalhe completo em
  [`docs/decisions/2026-09-13-carimbo-da-celula.md`](decisions/2026-09-13-carimbo-da-celula.md)
  e em [`docs/workflow-audit.md`](workflow-audit.md).

## `workflow_preview {run_id, route?}` — dry-run de um resume (#462, M11-S4)

Responde "o que replayaria, o que recomputaria e por quê" de um resume
`run_workflow(resume_run_id=...)` (com ou sem `route`) SEM gastar um token,
SEM escrever uma linha, e SEM consumir um dos 3 pivôs do run — decisão 5 do
mapa do épico #458: leitura não viaja na tool de lançamento.

- **Zero re-derivação de hash**: um `WorkflowEngine` real (`engine.ts`) roda
  contra um `ChildRuntime` seco (toda folha reporta `"failed"` genérico,
  nunca um `error_kind` de rota/quota — uma preview nunca pausa por um
  fault que um resume de verdade ainda não bateu) e uma fachada só-leitura
  sobre o cache SQLite real do run (`get` passa direto; `put` é um
  no-op — nunca escreve, nunca chama `onWrite`).
- **Por nó, no topo do spec** (`src/workflow/cache-preview.ts`):
  `replay` (célula no cache), `recompute` com `reason` `never_completed`/
  `identity_changed` (mesmo vocabulário de `cache.missed`, acima),
  `checkpoint_pending`, `upstream_missing`, `token_budget_exhausted`,
  `nested` (um nó `workflow` que rodou de verdade, agregado —
  `cells_replayed`/`cells_to_recompute`/`leaves_to_spawn`, nunca os nós
  internos), `no_leaves` (#503, abaixo) ou `unknown` (um fault do engine, um
  nó nunca alcançado, ou um tipo que esta classificação não modela — nunca
  bloqueia a preview, só conta em `engine_faults` quando é de fato um
  fault).
- **Totais**: `cells_replayed`, `tokens_saved`, `leaves_to_spawn`,
  `estimated_tokens_to_repay` (`leaves_to_spawn` vezes a média medida de
  tokens por célula custada DESTE run; `null` com `estimate_basis: null`
  se o run nunca custou uma célula), `route_applied` (`true` só quando
  `route` foi passado — não indica se algum nó de fato mudou), e
  `pivots_used` — os pivôs que este run JÁ GASTOU (`view.pivots.length`),
  **não afetado por esta chamada**: `workflow_preview` nunca consome um
  pivô, mesmo com `route` preenchido.
- **`workflow_preview` usa o loader de produção desde o #484**:
  `session-tools.ts:177-181` passa o MESMO `templateLoader(options.home)`
  que `chat.ts`/`dashboard.ts` já passam ao `WorkflowService` real (#464)
  direto para `workflowPreviewHandler` — um nó `{type: "workflow", ref}` que a preview
  atinge agora roda o engine aninhado de verdade e classifica como
  `outcome: "nested"` (`classifyNode`, `cache-preview.ts:279-288`, dispara
  quando o nó é `workflow` e o preview registrou algum hit/spawn dentro
  dele), igual a um resume real; antes, sem `loader`, `runNested` lançava
  `"workflow loader unavailable"` e o nó caía em `outcome: "unknown"`
  com `engine_faults` incrementado.
- **`outcome: "no_leaves"` (#503, follow-up de #484 rodada 2)**: um nó
  `parallel` cujo `branches` resolve para `[]` RODA na preview (o mesmo
  comportamento de produção, `engine.ts`'s `runParallel`, `[].every(...)`
  é vacuamente `true`) sem spawnar nenhuma folha e sem bater no cache —
  `classifyNode` (`cache-preview.ts`) agora nomeia esse caso `no_leaves`
  em vez de misturá-lo com `unknown`: o nó genuinamente rodou (seu
  `output` está em `RunResult.outputs`), só que não sobrou nada a
  replayar nem a pagar. `unknown` continua reservado para um nó nunca
  alcançado (pausado por outro motivo antes dele) ou para um tipo que
  esta classificação deliberadamente não modela — `verify`/`checkpoint`/
  `pipeline` na mesma forma (zero spawns, zero hits, executou) ainda saem
  `unknown` (`tests/workflow-cache-preview-writes.test.ts`, describe de
  não-regressão). Esse caminho também alcança `PreviewCacheFacade.put()`
  — `cache.put(...)` é chamado incondicionalmente mesmo sem spawnar
  nenhuma folha — e por isso o `put` da fachada carrega DUAS barreiras
  independentes contra escrita, não uma: o próprio `return false` do
  método e, por trás dele, o `SqliteWorkflowCache` guardado com uma
  `dummyOwnership` de `fence: -1`, que `ownershipGuard` recusaria de
  qualquer forma (`cache-preview.ts:19-35`, cabeçalho do arquivo).
- Chamar ANTES de `run_workflow(resume_run_id=..., route=...)`, para saber
  o custo de uma rota candidata antes de gastar um dos 3 pivôs.

## `workflow_templates` e o loader do operador (#464, M11-S6)

Biblioteca de specs do operador: um arquivo JSON por template, em
`<home>/workflows/<ref>.json` (`OPERATOR_TEMPLATES_DIR`,
`src/workflow/templates.ts`) — `ref` é o nome do arquivo sem `.json`,
validado contra `TEMPLATE_REF` (`/^[a-z0-9][a-z0-9_-]{0,63}$/`, fail-closed:
sem separador de caminho, sem `..`, nunca escapa do diretório).

- **`workflow_templates` é real**, não mais o stub `failSafe` de antes do
  #464: sem `name`, lista todo `.json` do diretório (`listTemplates`) —
  cada entrada `{ref, name?, nodes?, error?}`, um arquivo quebrado ou cujo
  nome de arquivo não é um `ref` válido vira `{ref, error}`, nunca cai
  silenciosamente da lista; com `name`, carrega e VALIDA esse template
  (`validateSpec`), citando os mesmos erros que `run_workflow` citaria.
  Diretório ausente é uma biblioteca vazia legítima (molde `readTiers`,
  #234), não um erro.
- **O MESMO loader liga o nó `{type: "workflow", ref}`**: `templateLoader(home)`
  (`templates.ts`) é passado a `WorkflowService` por `chat.ts`/
  `dashboard.ts` desde este issue — antes, nenhum composition root
  configurava `loader` nenhum, e `runNested` sempre lançava `"workflow
loader unavailable"` em produção; o #244 já validava um `ref` na CARGA da
  espec com um loader injetado à mão em teste, mas isso não mudava nada em
  produção sem este fio (`loader === undefined` devolvia `null` na
  validação, `schema.ts:771`). O critério de saída do milestone ("dois nós
  que chamam o mesmo template não colidem") só é verdade em produção a
  partir daqui.
- **`workflow_preview` recebe este MESMO loader desde o #484** — ver a
  seção acima (`session-tools.ts:177-181`).

## Manifesto de artefatos: `artifacts`/`artifact_faults` por run (#463, M11-S5)

Todo `write_file` que uma folha de qualquer nó do run realmente executa com
`ok: true` vira um registro em `RunResult.artifacts` — nunca `terminal`,
nunca uma tool MCP.

- **Um registro por escrita**: `{node_id, sub_id, path, bytes}` — `path`
  exatamente como a tool recebeu (nunca normalizado), `bytes` do próprio
  envelope da tool. Vivo em `workflow_status`'s `resultView`/`runningView`
  e durável em `pause_payload_json`/`durableRollup` — acumula através de um
  resume (`priorView.artifacts` é prependido, nunca apendado, ao que a
  stretch nova produziu).
- **Teto de 256 por FOLHA** (`MAX_ARTIFACTS_PER_LEAF`,
  `src/workflow/orchestration-runtime.ts:20`) — acima disso, o registro
  CAI e é contado em vez de crescer sem limite (invariante 3); a contagem
  vira uma entrada em `artifactFaults`: `"<nodeId>: N artifact records
dropped past the cap"`.
- **Colisão de caminho é ADVISORY** (doutrina #248, decisão 6 do épico
  #458): duas folhas do MESMO run escrevendo o MESMO `path` — a segunda
  escritora distinta dispara `"<nodeId>: artifact path written by 2
leaves: <path>"` em `artifactFaults` exatamente uma vez; nunca muda
  `status` (`deriveStatus` lê só `RunResult.faults`, nunca
  `artifactFaults`) — a escrita em si continua sem árbitro nenhum (a
  última grava por cima, silenciosamente, no sistema de arquivos), só a
  VISIBILIDADE da colisão é nova. Os dois canais de leitura expõem essa
  lista de jeitos diferentes: **ao vivo**, `resultView` funde
  `artifactFaults` dentro do array `faults` que ele devolve
  (`service-rollup.ts:140-144`) — uma leitura de `workflow_status` no
  mesmo processo VÊ a colisão em `faults`, mesmo ela nunca tendo entrado
  no `RunResult.faults` que decide o `status`; **durável**, `durableRollup`
  (`service.ts:187-207`) expõe a mesma lista sob a chave própria
  `artifact_faults` (`:203`), nunca dobrada em `faults_total` —
  `pausePayloadOf` (`route-override.ts:392`) monta `prior_faults`/
  `faults_total` só de `carriedFaults`/`result.faults`/`sandboxFaults`,
  nunca de `artifactFaults`. Depois de um resume, a stretch anterior dobra
  em `result.artifacts` e `result.artifactFaults` (`service.ts:999-1000`)
  antes de publicar — então o `faults` ao vivo da stretch nova também
  carrega a colisão de uma stretch anterior, não só o `artifact_faults`
  durável. Apêndice com o comportamento medido em
  [`docs/decisions/2026-09-10-fanout-fs-compartilhado.md`](decisions/2026-09-10-fanout-fs-compartilhado.md).
- **Dedup por caminho e colisão entre stretches** (fechados pelo #495,
  achados do veredito da PR #483/issue #485): um lote `[p, p]` de uma
  folha B, depois de A já ter escrito `p`, dispara o advisory só UMA vez —
  `RunResult.artifactCollisionPaths` (`accounting.ts:110`), um `Set` de
  caminhos já reportados, dedupa dentro de `recordLeafSideChannels`
  (`accounting.ts:182-208`). O mesmo `Set` cobre colisão ENTRE stretches:
  `pausePayloadOf` (`route-override.ts:401`) chama
  `recordCrossStretchArtifactCollisions` (`accounting.ts:229-243`) uma vez
  por escrita terminal, comparando os artefatos DESTA stretch contra os
  acumulados de todas as anteriores (`priorView.artifacts`) — por caminho,
  nunca por `sub_id`: o limite entre stretches já prova que são duas
  execuções distintas, então até um nó `agent` simples reescrevendo seu
  PRÓPRIO caminho de uma stretch anterior conta (doutrina #248). Caminho é
  comparado via `normalizedArtifactPath` (`accounting.ts:13-15`,
  `path.posix.normalize`, nunca `resolve`) — `./x` e `x` colidem;
  `RunArtifact.path` gravado continua a string crua. Nenhuma dessas
  mudanças toca `status` nem `RunResult.faults` — seguem gaps do próprio
  advisory, não do runtime.
- **Um advisory por caminho, através de N resumes** (#501, follow-up do
  veredito non_blocking 3/4 da PR #495): o `Set` acima nasce vazio a cada
  `RunResult` novo — sem memória do que uma stretch ANTERIOR já reportou —
  então um caminho já flagado (duas folhas na stretch 1) que uma folha
  DIFERENTE reescreve na stretch 2 disparava um SEGUNDO advisory, com
  `node_id` distinto: `service.ts:1000`'s dobra terminal antepunha
  `priorView.artifact_faults` a `result.artifactFaults` sem checar se o
  caminho já constava. `dedupeArtifactFaultsByPath` (`accounting.ts:265-277`)
  e `foldArtifactFaults` (`accounting.ts:285-288`) fecham isso: mantêm a
  PRIMEIRA ocorrência de cada caminho colidido na lista MESCLADA
  (`[...prior, ...atual]`), nunca a mais recente — inclusive limpando uma
  duplicata que já tivesse ficado gravada num `pause_payload_json` de antes
  deste fix, já que a checagem
  roda de novo a cada fold. `pausePayloadOf`/`route-override.ts` não muda:
  o `pause_payload_json` persistido continua byte-idêntico (só a leitura AO
  VIVO — `resultView`, via `result.artifactFaults` — dedupa); uma leitura
  FRIA (`workflow_status` num run dormente, `durableRollup`,
  `service.ts:203`) ainda expõe a duplicata que já estava persistida — não
  coube trocar isso também sem passar do teto de 1284 linhas de
  `service.ts`. As duas mensagens que geram o texto do advisory
  (`recordLeafSideChannels`, `recordCrossStretchArtifactCollisions`)
  compartilham `COLLISION_FAULT_MARKER` (`accounting.ts:21`) — o mesmo
  texto de antes, byte a byte — para que o parser de caminho de
  `dedupeArtifactFaultsByPath` nunca divirja do que as gera. Cenário "nó
  DIFERENTE na stretch 2 colidindo com um caminho já flagado na stretch 1"
  e "o MESMO caminho, já flagado, reescrito de novo numa stretch depois" —
  ambos vermelhos por asserção na base — vivem em
  `tests/workflow-artifacts-cross-stretch-dedup.test.ts`.
- **Limitações que sobraram, sem issue aberta cobrindo nenhuma delas**:
  (a) o custo O(N²) de
  `recordLeafSideChannels`/`recordCrossStretchArtifactCollisions` (um
  `.filter` por artefato já registrado) e o payload de `artifacts`/
  `artifact_faults` sem teto por run continuam sem solução — nenhum caso
  de uso hoje aproxima o custo quadrático de um problema real; (b) uma
  leitura FRIA de um run dormente (`workflow_status` sem processo vivo,
  `durableRollup`) ainda pode expor uma duplicata de advisory já gravada
  antes do #501 — só a leitura ao vivo dedupa (acima).
- **Fora do escopo original, limitação registrada no próprio código**: um
  sub-workflow por `ref` nunca tem seus artefatos checados contra os do run
  pai — `foldNestedCounters` (`accounting.ts:265-285`) só concatena as
  listas, sem re-checar colisão contra o `RunResult` do pai; o comentário
  da própria função nomeia isso.

## Sinal do processo e envelope de falha (contexto, não uma tool nova)

Duas peças menores do mesmo épico, sem superfície de tool própria:

- **SIGTERM/SIGINT no ledger**: `WorkflowService.shutdown("signal")` grava
  `segment.completed {status: "interrupted", reason: "signal"}`, distinto
  de `workflow_cancel` (`reason: "cancelled"`) — detalhe e o limite conhecido
  (o que uma SEGUNDA entrega de sinal durante o shutdown ainda pode
  interromper) em
  [`docs/decisions/2026-09-12-sinal-no-ledger.md`](decisions/2026-09-12-sinal-no-ledger.md).
- **`dead_turn`**: o 10º `ErrorKind` — um turno final vazio e sem tool call
  — e o envelope aditivo de `delegate_task` em
  [`docs/decisions/2026-09-12-envelope-delegate-aditivo.md`](decisions/2026-09-12-envelope-delegate-aditivo.md).
