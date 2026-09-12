# Auditoria por nó: o ledger de eventos do workflow

Comportamento de `src/workflow/audit-model.ts`, `audit-producers.ts`,
`audit-runtime.ts`, `audit-cache.ts`, `audit-trail.ts`, `audit-query.ts`,
`live-tail.ts` e `src/state/audit-repository.ts` — épico #364, doze issues
mergeadas: #365 identidade causal, #366 `leaf.*`, #367 `tool.*`, #368
`cache.*`/`segment.*`/`node.paused`/`audit.gap {process_crash}`, #369 live
tail + `watch --events` + `workflow_status.live_tail`, #370 fatia de
mutação estendida aos produtores e ao live tail, #373 `workflow_audit`
drena o `AuditTrail` no mesmo turno ou reporta `integrity.pending`, #378
`tool.completed {reason:"cancelled"}` ao fechar um leaf com dispatch ainda
em voo, #380 sink de aviso em produção, #383 lacunas de mutação do
veredito da PR #382, #386 allow-list sem entradas sem produtor (remoção de
`node.started`/`node.completed`/`node.failed`/`node.output`), #390 filtros
vazios (`""`/`0`) tratados como ausência. Épico #421 (M10 "Supervisão em
voo") acrescentou dois membros à allow-list depois dessas doze: `leaf.steered`
(#423, S2) e o 5º `pause_reason` de `node.paused`, `route_fault` (#426, S5).
Épico #458 (M11 "Rotas, cache e artefatos") acrescentou um 22º `event_type`,
`node.rerouted` (#460, S2), e enriqueceu `cache.missed`/`cache.replayed` com
`reason`/`version_state` (#461, S3) — tratados abaixo junto com o resto de
cada tabela.

## O que é e por que

Todo `run_workflow` grava, além do estado do run, um segundo fluxo
append-only na mesma `state.db`: um evento por marco de execução (nó, leaf,
tool call, hit/miss de cache, início/fim de segmento), metadata-only —
nunca prompt, resposta, raciocínio ou argumento/resultado de tool em claro.
Existe para dar às duas propriedades de engenharia do runtime uma trilha
observável, não só uma garantia interna (CLAUDE.md):

- **Invariante 2** (falha nunca silenciosa): toda perda — fila cheia,
  payload corrompido, sink permanentemente fora do ar, retenção que apagou
  eventos antigos, processo que morreu no meio de um segmento — vira um
  evento `audit.gap` ou `audit.unavailable` nomeado com a razão, nunca um
  buraco mudo na sequência.
- **Invariante 4** (escrita cross-process sempre sob lease/fence): cada
  gravação carrega a `ownership` (fence + holder + expiry) da aquisição que
  a produziu; `AuditRepository.append` recusa a escrita se essa fence não
  bater mais com o dono atual do lease do run.

`AUDIT_POLICY` (`audit-model.ts:464-470`), devolvida em toda página de
consulta:

```
mode: "metadata_only"
raw_payloads: "redacted_or_excluded_at_ingest_and_read"
private_reasoning: "excluded_private_state"
provider_calls: "none"
summary_generated: false
```

`LOHRA_AUDIT` decide se o runtime sequer usa a trilha: `off`/`0`/`false`/`no`
desliga (`auditEnabled`, `audit-model.ts:472-488`, lido em
`service.ts:400`); qualquer outro valor reconhecido (`on`/`1`/`true`/`yes`,
ou a variável ausente/vazia) liga; um valor não reconhecido avisa e
**permanece ligado** — nunca desliga por engano. `LOHRA_AUDIT_MAX_EVENTS`
sobrepõe o teto de eventos retidos por run (`resolveAuditSettings`,
`audit-model.ts:491-509`, lido no construtor de `AuditRepository`,
`audit-repository.ts:167-168`); um valor não inteiro ou menor que 1 avisa e
mantém o padrão (2048).

`LOHRA_AUDIT` desligado (`auditEnabled` acima) também torna `workflow_leaf_read`
inutilizável para runs novos: a checagem de posse exige um `leaf.started` já
gravado neste mesmo ledger — sem trilha, essa consulta nunca encontra o
evento, e a tool recusa um `sub_id` real com a mesma mensagem de um `sub_id`
alheio (`src/workflow/leaf-read-tool.ts:163-170`), fail-closed em vez de
confiar numa alegação não verificável (detalhe da tool em
[`docs/workflow-supervision.md`](workflow-supervision.md)).

## Identidade causal

Toda gravação carrega `publicAuditIdentity` (`audit-model.ts:443-462`):

| campo        | o que é                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_id`     | sempre presente; acima de 128 caracteres vira `<95 chars>~<sha256[:32]>`                                                                                                                                        |
| `segment_id` | a aquisição (stretch) que produziu o evento                                                                                                                                                                     |
| `node_path`  | **um único elemento** — o nó imediato do evento, clipado a 64 chars; não é a cadeia causal completa                                                                                                             |
| `sub_id`     | a sessão do leaf spawnado, quando o evento é sobre um leaf/tool call                                                                                                                                            |
| `attempt`    | 0-based nos eventos `leaf.*`/`tool.*` — **não** é o `attempt` 1-based do payload de `segment.started`; detalhe e custo de tratar `attempt: 0` como filtro ausente em "Consulta e o envelope `integrity`" abaixo |

A cadeia causal inteira (até 8 ancestrais, cada um clipado a 64 chars —
`PATH_FIELDS`/`node_path` em `safeValue`, `audit-model.ts:345`) aparece
só dentro do `data.node_path` de `leaf.started` (`payload.node_path:
cc.nodePath`, `audit-runtime.ts:372`) — não em `identity`, que guarda só o
último elemento (`audit-model.ts:454`).

## Tabela de eventos

Vinte e dois tipos formam a allow-list (`SAFE_EVENT_TYPES`,
`audit-model.ts:116-146`); um `event_type` fora dela vira
`audit.unavailable` na gravação. `node.completed`, `node.failed`,
`node.output` e `node.started` nunca tiveram produtor e saíram da
allow-list em #386 — o ciclo de vida de um nó continua observável só por
`workflow.node` (abaixo), que já existia antes deste épico, e por
`node.paused`, o único membro da família `node.*` que #368 decidiu manter.

| `event_type`        | produtor                                                                                                                                                                                                                                            | quando                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `segment.started`   | `announceSegmentStarted` (`audit-producers.ts:256`)                                                                                                                                                                                                 | primeiro evento de uma aquisição, antes de `workflow.plan`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `workflow.plan`     | `announcePlan` (`audit-producers.ts:231`)                                                                                                                                                                                                           | logo após `segment.started`; `data.node_path` lista todos os nós do spec                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `workflow.node`     | `forwardEvent` (`audit-producers.ts:194`)                                                                                                                                                                                                           | a cada evento `node` do engine (running/complete/failed/…)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `workflow.items`    | `forwardEvent`                                                                                                                                                                                                                                      | progresso item-a-item de um `pipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `workflow.fault`    | `forwardEvent`                                                                                                                                                                                                                                      | um fault do engine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `node.paused`       | `announceNodePaused` (`audit-producers.ts:289`)                                                                                                                                                                                                     | run pausado; `payload.reason` ∈ `checkpoint`, `quota_exhausted`, `route_fault` (5º valor, #426/M10-S5), `token_budget_exhausted`, `user_requested` — nunca duplica nem substitui `workflow.node`/`workflow.fault`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `node.rerouted`     | `announceRerouted` (`audit-producers.ts:329-353`, #460/M11-S2)                                                                                                                                                                                      | um evento por NÓ que um pivô de rota efetivamente reescreveu — nunca um por pivô; chamado logo depois de `announceStretchStart` (`service.ts:935-940`), então sempre no segmento NOVO, depois de `workflow.plan`, nunca antes nem no segmento anterior; `payload.channel` ∈ `operator` (um `route` explícito) / `route_envelope` (a sugestão do envelope aplicada sozinha num resume sem `route`, #459/#460); `payload.pivot` é a contagem de pivôs do run até aqui; `payload.from`/`payload.to` são objetos `{provider, model}` (`CONTAINER_FIELDS`, não achatados) com a routing REAL do nó antes/depois — resolvida via tiers quando o nó só declara `tier`; zero eventos para um nó que nunca declarou rota                                                                                                   |
| `segment.completed` | `announceSegmentCompleted`, ou `announceProcessCrash` para a segmento anterior                                                                                                                                                                      | fim normal (`status` = `complete`/`paused`/`cancelled`/`failed`, com `reason:"cancelled"` para um `cancel(runId)`) ou, sob retomada de dono morto, o segmento antigo fechado como `interrupted`/`process_crash`; um shutdown por SIGTERM/SIGINT (`WorkflowService.shutdown("signal")`, #428) grava `{status:"interrupted", reason:"signal"}` em vez de `cancelled` — o único jeito de um resume distinguir sinal de `workflow_cancel`                                                                                                                                                                                                                                                                                                                                                                             |
| `workflow.done`     | `announceDone` (`audit-producers.ts:251`)                                                                                                                                                                                                           | último evento do segmento                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `audit.gap`         | vários (ver "Fail-closed" abaixo)                                                                                                                                                                                                                   | toda perda nomeada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `audit.truncated`   | `publicAuditEvent` (`audit-model.ts:407-438`)                                                                                                                                                                                                       | evento serializado > 2048 bytes (`AUDIT_EVENT_BYTES`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `audit.unavailable` | leitura (`parseEvent`/`query`, `audit-repository.ts`)                                                                                                                                                                                               | `event_type` fora da allow-list, payload corrompido no disco, ou run tombado/nunca gravado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `leaf.started`      | `auditedChildRuntime.spawn` (`audit-runtime.ts:359-381`)                                                                                                                                                                                            | um `ChildRuntime.spawn` bem-sucedido                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `leaf.completed`    | `close()` (`audit-runtime.ts:239-266`), chamado de `collect()` (`audit-runtime.ts:382-420`)                                                                                                                                                         | `collect` volta `status: "complete"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `leaf.failed`       | `close()` (`audit-runtime.ts:239-266`), chamado de `collect()` (`audit-runtime.ts:382-420`)/`cancel()` (`audit-runtime.ts:421-427`)                                                                                                                 | `collect` falha/cancela/estoura timeout, ou `cancel()` — sempre exatamente um evento terminal por `sub_id`; carrega `payload.error_kind` (vocabulário em "Vocabulário de falhas" abaixo) quando `collected.errorKind` não é `null`/`undefined`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `leaf.steered`      | `auditedChildRuntime.steer`, dentro de `deliverSteer` (`audit-runtime.ts:332-356`, #423)                                                                                                                                                            | grava só quando o core ACEITA o steer (#444) — `queued: true` (fila) ou a ressurreição `{queued: false}` sem `refused` (novo turno), o que inclui um retry de schema que roda depois do `leaf.completed`/`leaf.failed` do próprio leaf (`engine.ts:296-312` — o leaf já reportou `status: "complete"` antes do engine checar o schema); nunca grava para `refused: "steer_cap"` nem para um `sub_id` terminal/desconhecido (`outcome === null`); `payload.source` é `engine` (todo `steer()` interno do engine, default) ou `operator` (4º argumento de `runtime.steerOutcome` — `workflow_steer`, `src/workflow/steer-tool.ts:285`, é o chamador desde #424); `payload.message_chars` é o único dado do texto do steer — metadata-only, nunca o texto; `attempt` é o do `spawn` original, não um índice de retry |
| `tool.started`      | `auditedToolDispatch` (`audit-runtime.ts:131`)                                                                                                                                                                                                      | toda chamada de tool feita por um leaf                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tool.completed`    | `auditedToolDispatch`'s sync-denial record (`audit-runtime.ts:186-193`) · `close()`'s pending-dispatch flush (dispatch ainda aberto ao fechar o leaf, `audit-runtime.ts:248-257`) · `onToolSettled` (assentamento real, `audit-runtime.ts:483-501`) | `{status:"error", reason:"sandbox_denied"}` — recusa síncrona do sandbox; `{status:"error", reason:"cancelled"}` — o leaf fechou (cancel, shutdown ou timeout) com esse dispatch ainda em voo, emitido por `close()` **antes** do evento terminal do leaf; `{status:"success"}`/`{status:"error"}` sem `reason` — assentamento real                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cache.replayed`    | `auditedWorkflowCache.get` (`audit-cache.ts:72`)                                                                                                                                                                                                    | hit de cache; `payload.usage` só quando a célula tem custo (nunca um zero inventado para uma célula `parallel` com `cost: null`); desde #461 (M11-S3) também `payload.version_state` ∈ `current` (o carimbo bate com `CELL_IDENTITY_VERSION`), `stale` (carimbo diferente — a identidade da célula mudou desde que foi escrita, ex. pivô de rota) ou `unstamped` (célula de antes da coluna `identity_version` existir — só o `SqliteWorkflowCache`; `MemoryWorkflowCache` nunca reporta `unstamped`, só `current`/`stale`) — marca, nunca invalida (decisão 3, épico #458, `docs/decisions/2026-09-13-carimbo-da-celula.md`)                                                                                                                                                                                     |
| `cache.missed`      | `auditedWorkflowCache.get`                                                                                                                                                                                                                          | miss de cache; desde #461 (M11-S3) carrega `payload.reason` — omitido (nunca `null`) quando o chamador não nomeou `nodeId` — ∈ `never_completed` (este par run/nó nunca teve célula, sob nenhum hash) ou `identity_changed` (já teve, sob um hash DIFERENTE — a identidade da célula mudou, tipicamente um pivô de rota)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cache.stored`      | `auditedWorkflowCache.put` (`audit-cache.ts:82`)                                                                                                                                                                                                    | escrita de cache bem-sucedida                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cache.unavailable` | `auditedWorkflowCache.put`                                                                                                                                                                                                                          | escrita de cache recusada (`payload.reason: "store_failed"`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

`identity.node_path` de um evento `cache.*` já vinha do `nodeId` que o
chamador passa a `get`/`put` (`WorkflowCache`, cache.ts) antes de #461 — o
que mudou nessa issue é que o `nodeId` agora chega ESCOPADO
(`scopedCheckpointId`, `<workflowNodeId>.<innerNodeId>` dentro de um nó
`workflow` aninhado) tanto no `get` quanto na coluna física
`workflow_node_cache.node_id` — antes só `cacheGet`/`nodeCosts` recebiam a
forma escopada; a coluna da célula guardava o id cru. Detalhe da coluna em
[`docs/state-sqlite.md`](state-sqlite.md).

`tool.started`/`tool.completed` e `leaf.started`/`leaf.completed`/
`leaf.failed` compartilham a mesma identidade (mesmo mapa `open` em
`audit-runtime.ts`, populado em `spawn()` e apagado no primeiro terminal por
`close()`) — filtrar por `sub_id` devolve um leaf junto com toda tool que
ele chamou. `leaf.steered` (#423) é a exceção: sua identidade vem de um
segundo registro, `identities` (`audit-runtime.ts:233`), populado junto com
`open` mas NUNCA apagado por `close()` — por isso um `steer()` de retry de
schema, que roda depois do `leaf.completed`/`leaf.failed` já ter esvaziado
`open`, ainda encontra identidade (os valores são os mesmos que `open`
carregava).

`payload.tool_name_state` de `tool.started` é `known_tool` só para nomes no
catálogo builtin (`KNOWN_TOOL_NAMES`, construído uma vez de
`BUILTIN_DEFINITIONS`, `audit-runtime.ts:107-109`); toda tool MCP
(`mcp_{server}_{tool}`, registrada por run num `ToolRegistry` fora do
alcance deste decorador) reporta `unknown_tool` mesmo sendo uma chamada
legítima — fixado por `tests/workflow-audit-tool.test.ts`, não um bug.

## Vocabulário de falhas (`error_kind`)

Épico #396 (M8), issues #397-#399: `ErrorKind` (`src/transports/error-kinds.ts`)
é o vocabulário fechado de dez valores que toda camada — folha, run,
rollup e auditoria — usa para falar de uma falha de provedor, em vez de
`string | null` livre. `classifyProviderError` (`src/transports/errors.ts:66-83`)
produz nove deles; o décimo (`dead_turn`, #429) tem produtor próprio,
descrito abaixo:

| `error_kind`      | gatilho                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quota_exhausted` | `RateLimitError`, `statusCode`/`status` 429, ou `code` num conjunto conhecido de quota (`insufficient_quota` e afins)                                               |
| `auth_failed`     | `statusCode` 401 ou 403                                                                                                                                             |
| `model_not_found` | `statusCode` 404 **e** indício de modelo (`code`/`payload.error.code`/`.type`/mensagem citam "model", `errors.ts:58-64`)                                            |
| `route_fault`     | `code` num conjunto de falha de rede (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`) ou `statusCode` 5xx                                                   |
| `unknown`         | qualquer outro `ProviderCallFailed` sem mapeamento fino — nunca `null` para um erro de provedor (invariante 2)                                                      |
| `dead_turn`       | turno final com `content` vazio (após trim) e sem tool calls — produzido em `child-runner.ts`, não por `classifyProviderError`; `status` continua `complete` (#429) |
| (nenhum — `null`) | erro que não é `ProviderCallFailed` — o resto da cadeia (`child-runner.ts`) já trata `null` como "não é falha de provedor"                                          |

`sandbox_denied`, `timeout`, `cancelled` e `context_length` completam os
nove de `classifyProviderError` — reservados para reuso futuro sem produtor
hoje: `timeout`/`cancelled` para a folha, `context_length` para o
classificador de janela, e `sandbox_denied` nomeado assim (não
`sandbox_refused`) por decisão do épico #396. `sandbox_denied` também
nomeia o campo `reason` de `tool.completed` na tabela acima — outra
allow-list fechada, `SAFE_STRING_VALUES.reason` (`audit-model.ts`), não a
mesma lista de `error_kind`; mesma palavra, dois campos distintos.

`ERROR_KIND_SET` é a allow-list de `error_kind` na sanitização do payload
(`audit-model.ts:230`) — um valor fora do vocabulário vira `{state:
"excluded_by_policy"}`, o mesmo marcador que `forced_fallback` recebe
abaixo, nunca gravado cru.

`quota_exhausted` nunca chega a `leaf.failed`/`RunResult.faultKinds` — e,
desde #426 (M10-S5), nem `auth_failed`/`route_fault`/`model_not_found`
chegam: a guarda de `debitLeaf`, generalizada de `!== QUOTA_EXHAUSTED` para
o predicado único `pausesRun(kind)` (`route-faults.ts`), exclui os quatro
explicitamente antes de `recordFaultKind` (`engine-utils.ts:487`) — um kind
que pausa o run (`quota_exhausted` ou um dos três de rota) vira pausa
(`pause_reason` correspondente), nunca uma falha de leaf contabilizada, já
que a folha será re-executada no resume e contá-la dobraria a cada
retomada. Detalhe de `RunResult`/`workflow_status` (não deste ledger):
`fault_kinds` no rollup vivo (`service-rollup.ts:63`) é só do stretch
atual, em memória; `fault_kinds_total` no payload durável
(`service.ts:115,161,212`) acumula entre stretches, e a releitura filtra
por `isErrorKind` — um kind corrompido no disco é descartado em silêncio
dessa lista (nunca vira `unknown`), diferente de `prior_faults`, que
preserva o texto cru; a próxima escrita terminal reescreve
`prior_fault_kinds` a partir dessa MESMA view filtrada, concatenando o que
esta stretch produziu (`pausePayloadOf`, `route-override.ts:198-221`,
consolidador extraído de `service.ts` por #427/M10-S6 — antes vivia inline
em `launchDurable`), então o kind corrompido também some do payload durável
a partir daí, não só da leitura que o filtrou.

### `forced_fallback` (removido) e `forcing_fallbacks`

`ChildResult.forcedFallback` — e o campo `forced_fallback` que
`leaf.completed` carregava — saiu da camada de workflow inteira em #403
(PR #417, rodada 2): o único gatilho que a rodada 1 usou (`provider`
nomeado sem `model`) é o caminho normal de deixar o provedor escolher seu
modelo padrão, não um sinal real de fallback forçado — nada no runtime
percorre uma cadeia de fallback de verdade. Uma linha de ledger gravada
antes de #403 com `forced_fallback: true`/`false` no payload continua no
disco, mas a releitura hoje sanitiza esse campo como qualquer chave fora do
allow-list: `audit-model.ts`'s `BOOLEAN_FIELDS` não lista mais
`forced_fallback`, então uma consulta a um evento antigo devolve
`{state: "excluded_by_policy"}` para ele — um marcador nomeado, nunca um
apagamento silencioso.

`forcing_fallbacks` (`RunResult.forcingFallbacks`, `workflow_status`)
continua a existir, mas conta só uma coisa: o ENGINE caindo para o texto
cru de um leaf quando o nó pediu `schema`/`schema_ref` **e** `tool_less:
true` e o leaf completou sem emitir a tool call `StructuredOutput`
(`resolveLeafRequestOptions`/`extractForcedOutput`, `engine-utils.ts:198,
240-250`; incrementado em `engine.ts:332`). Nunca conta uma escolha de
roteamento (`provider`/`model`/`tier`) feita de propósito.

## Ciclo de um segmento

Uma aquisição (stretch) bem-sucedida, na ordem em que os eventos são
enfileirados (`service.ts:935-991`):

```
segment.started {attempt}
workflow.plan
node.rerouted {channel, pivot, from, to}          (zero ou mais — só se um pivô de rota reescreveu algum nó neste resume)
workflow.node / workflow.items / workflow.fault  (zero ou mais)
node.paused {reason}                              (só se o run pausou)
segment.completed {status}
workflow.done {status}
flushBeforeRelease()                              (só no caminho durável)
release do lease
```

`node.rerouted` (quando presente) é emitido logo depois de
`announceStretchStart` (`service.ts:935-940`) — sempre depois de
`workflow.plan`, sempre antes dos eventos de nó do segmento novo (#460,
M11-S2). O caminho `.catch` do stretch emite `segment.completed
{status:"failed"}` antes de `workflow.done` (`service.ts:1015`).
`flushBeforeRelease` (`audit-producers.ts:323-327`, emenda de #368 em
2026-09-11) drena a fila do `AuditTrail` **antes** de liberar o lease — sem
isso, os três eventos terminais que `announceStretchEnd` acabou de
enfileirar ainda estariam na fila quando a fence desaparecesse, e
`AuditRepository.append` os recusaria silenciosamente sob uma fence já
vencida.

**Retomada de dono morto**: quando `WorkflowService.start` detecta um run
`orphaned` (status `running`, lease sem dono vivo, `service.ts:683-688`),
adquire uma fence nova e, antes de iniciar o segmento novo, fecha o
segmento anterior sob essa fence nova:

```
segment.completed {status:"interrupted", reason:"process_crash"}   — nomeando o segmento ANTIGO (ou nenhum, para um run durável de antes de #365)
audit.gap {reason:"process_crash", count_state:"unavailable"}       — sem segment_id, sem dropped_count
```

(`announceProcessCrash`, `audit-producers.ts:277-285`; chamado em
`service.ts:896`). Distinto de `audit.gap {reason:"sink_failure"}` — o
único outro produtor de `audit.gap` fora da família de recusas do
`AuditTrail`/retenção.

## Fail-closed (invariante 4)

`recordAuditEvent` (`audit-producers.ts:160-173`) é a regra que todo
produtor deste código compartilha: se `trail` não existe, é um no-op; numa
aquisição durável cuja `ownershipOf()` já voltou `null`, o evento é
**descartado** com um `warn` nomeado, sem sequer chegar ao `AuditTrail` —
nunca gravado sem fence.

`AuditRepository.append` (`audit-repository.ts:174-286`) confere a fence
dentro da mesma transação: quando `ownership` é passado mas
`fence`/`holder`/`expiry` não batem mais com o dono atual do lease, devolve
`null` (uma **recusa**, não uma falha — uma aquisição superada apresentando
um token velho é o caso esperado). Uma recusa incrementa
`refusals` — contagem em memória por `run_id`, LRU por instância deste
`AuditRepository`, evictada ao ultrapassar `maxRuns` (padrão 64); um run
evictado volta a reportar `refused_writes: 0` — e emite **uma** linha de
`warn` nomeada (consolidado por #380: antes desse fix a mesma recusa era
logada até três vezes, e `chat.ts`/`dashboard.ts` não passavam nenhum sink
real para `AuditRepository`/`AuditTrail`, então a linha nunca saía de
produção — `src/commands/chat.ts:263-352`, `dashboard.ts:259-311`,
`src/commands/session-tools.ts:47-55` agora passam um `warning` real).

O caminho de teste sem `store` (`WorkflowService.launch`, sem
`launchDurable`, `service.ts:576-579`) grava sem `ownership` nenhuma — a
checagem de fence é pulada inteiramente. Produção sempre chama
`launchDurable` (`service.ts:555`); esse caminho é só para teste.

Outras perdas nomeadas, todas via `audit.gap {reason, dropped_count}`
(`AuditTrail`, `audit-trail.ts`): `corrupt_payload` (sanitização do
payload lançou), `queue_overflow` (fila de 256 cheia), `drop_bucket_overflow`
(mais de 256 buckets de perda distintos acumulados). Uma falha permanente do
sink (`append` falhou em todas as tentativas de retry) marca o `AuditTrail`
como `stopped` — toda gravação seguinte, do run inteiro compartilhando esse
`AuditTrail`, é recusada com um `warn` nomeado (`audit-trail.ts:60-63,
170-174`) — processo inteiro, não por run.

## Consulta e o envelope `integrity`

`AuditRepository.query(query)` devolve uma página (`AuditPage`,
`audit-repository.ts:27-35`): `run_id`, `availability`
(`"available"`/`"unavailable"`), `filters`, `events`, `page`
(`after_seq`, `next_after_seq`, `snapshot_seq`, `limit_requested`,
`limit_effective` — clampado a 100 —, `returned`, `has_more`), `policy`
(o `AUDIT_POLICY` acima) e `integrity`:

- `event_markers` — contagem de `audit.gap`/`audit.truncated`/
  `audit.unavailable` no snapshot inteiro (não só na página retornada).
- `field_markers` — contagem de campos individuais marcados `redacted`,
  `truncated`, `unavailable`, `excluded_by_policy`, `excluded_private_state`.
- `refused_writes` — a contagem LRU por instância descrita acima.
- `notices` — os próprios marcadores + o `audit.gap {retention_limit}`
  sintetizado (abaixo), capados em 20 (`notices_returned`); `notices_total`
  e `notices_truncated` dizem se sobrou algo fora da página. Filtros
  (`node_id`, `event_type`, `sub_id`, `segment_id`, `attempt`) afetam só
  `events`, nunca `notices`. `""` (nos quatro campos de string, após trim),
  `attempt: 0` e `snapshot_seq: 0` significam filtro/cursor AUSENTE, não um
  valor a bater ou uma página travada no seq 0 — a mesma query que omitir o
  campo (`parseAuditQuery`, `audit-query.ts`, #390). `identity.attempt` é
  0-based nos eventos `leaf.*`/`tool.*` (a primeira tentativa grava
  `attempt: 0`, `engine-utils.ts:289`) — tratar `attempt: 0` como ausência
  custa a capacidade de filtrar SÓ a primeira tentativa por essa superfície;
  uma consulta sem esse filtro já inclui esses eventos, só não isolados.

Um run sem `workflow_audit_state` e sem tombstone devolve
`availability:"unavailable"` com um único `notice` `audit.unavailable
{reason:"not_recorded"}`.

### `integrity.pending`

`pending` não é campo de `AuditPage.integrity` (`audit-repository.ts`) — é
acrescentado por cima, só quando `workflow_audit` é servido por
`WorkflowTool.auditWithFlush` (`tool.ts:135-139`), o mapeamento que
`workflowToolHandlers` usa depois que uma sessão tem uma `WorkflowService`
viva (`composeSessionTools`, `session-tools.ts:106`). Nunca aparece numa
leitura crua: `AuditRepository.query` direto (`lohra workflow audit`,
`commands/workflow.ts:145`) ou `WorkflowTool.audit()`/`workflowAuditHandler`
(`tool.ts:40-42,124-127`) — usado como placeholder do registro antes de
`composeSessionTools` rodar (`createSessionToolBase`,
`session-tools.ts:55-58`) e como o handler de `workflow_audit` da
composição separada de `chat-tools.ts:20-23`, sem `auditWithFlush`.

`auditWithFlush` espera até `AUDIT_READ_FLUSH_TIMEOUT_MS` (250 ms,
`tool.ts:21`) o dreno do `AuditTrail` do processo
(`WorkflowService.auditPendingAfterFlush`, que chama `AuditTrail.flush`,
`service.ts:1214-1217`) antes de consultar, para que uma leitura no mesmo
turno de um `run_workflow` não veja `events: []` por eventos ainda na fila.
Se o dreno não terminar no prazo, o envelope traz `integrity.pending: <n>`
— só quando `n > 0` (`auditResult`, `tool.ts:29-37`).

`<n>` é `AuditTrail.pendingCount()` (`audit-trail.ts:124-126`): a fila mais,
se houver, a escrita em voo — do `AuditTrail` **inteiro do processo**, não
filtrado por `run_id`. A descrição da própria tool (`builtin-definitions.ts:573`)
diz isso mesmo: conta eventos ainda em buffer neste processo para qualquer
run, não filtrado por `run_id`, então pode vir maior que zero mesmo quando
este run não tem nada pendente; uma leitura posterior pode mostrar mais
eventos deste run. Descrição e código concordam — um processo atendendo
vários runs com a mesma `WorkflowService` reporta o `pending` de todos
juntos, não importa qual `run_id` a consulta pediu. Uma leitura de outro
processo nunca seta `pending` — não há fila deste processo para drenar ali.

Janela conhecida: um `AuditTrail` já `stopped` (falha permanente do sink,
"Fail-closed" acima) com a fila já vazia faz `flush()` devolver `false` sem
nada para drenar (`audit-trail.ts:128-137`) — `auditPendingAfterFlush` lê
`pendingCount()` como `0`, e o envelope sai **sem** `pending`, mesmo que o
sink não grave mais nada dali em diante. `record()`, no writer parado,
recusa com um `warn` nomeado antes de sequer enfileirar
(`audit-trail.ts:60-63`, já citado em "Fail-closed" acima) — mas essa
recusa nunca passa por `AuditRepository.append`, então não incrementa
`refused_writes`: não há marcador de página para essa perda específica, só
o `warn` no momento em que aconteceu.

## Live tail (por processo — não é o ledger)

`WorkflowLiveTail` (`src/workflow/live-tail.ts`) é um anel em memória, um
por run conhecido **neste processo**, teto de 256 eventos **e** 64 KiB
serializados por run (`LIVE_TAIL_EVENTS`, `LIVE_TAIL_BYTES`), o que vier
primeiro — nada em comum com o teto de 2 KiB por evento do ledger
(`AUDIT_EVENT_BYTES`, esse é outro número). Só guarda `WorkflowLiveEvent`
(`plan`/`node`/`items`/`fault`; `done` é um sinal de esquecimento — nunca
armazenado, nunca ocupa um cursor). **`leaf.*`, `tool.*`, `cache.*` e
`segment.*` nunca aparecem no live tail** — só no ledger durável, via
`workflow_audit` ou `lohra workflow watch --events`.

`workflow_status`, quando lido no mesmo processo que lançou ou retomou o
run (`WorkflowLiveTail.isKnown`, verdadeiro só se este `tail` já observou
um evento ao vivo desse run — nunca por saber o run só de forma durável),
devolve `live_tail: {events, next_cursor, dropped}` (`tool.ts:104`).
`next_cursor` é monotônico pela vida inteira do run **neste processo** —
nunca regride, nem numa pausa seguida de auto-retomada no mesmo processo;
`dropped` conta quanto caiu do anel ao cruzar o teto — nunca silencioso. Um
teto de 1024 runs conhecidos (`KNOWN_RUNS_CAP`) evicta só um run cujo anel
já está vazio (um `done` já processado); se todos os outros ainda estão
vivos, o mapa cresce em vez de descartar um run vivo.

`lohra workflow watch RUN_ID --events`, de qualquer processo, segue o
**ledger durável** por cursor (`drainAuditEvents`, `src/commands/
workflow.ts:83-97`): a cada poll, imprime uma linha nova por evento
(`seq  event_type  node_path  sub_id?  segment_id[:8]` — o segment_id
truncado a 8 caracteres, `renderAuditLine`, `workflow.ts:78`), nunca repete
o que já mostrou. `lohra workflow audit RUN_ID [--node/--event/--sub-id/
--segment-id/--attempt/--after-seq/--snapshot-seq/--limit]` imprime a
página `AuditPage` inteira em JSON — a mesma tool `workflow_audit` que o
agente usa, com a mesma semântica de "sem filtro": `--attempt 0` e
`--snapshot-seq 0` passam como ausentes, não como o filtro literal.

## Retenção

Padrões (`audit-model.ts:4-8`, sobrepostos por `AuditRepositoryOptions`):
2048 eventos por run (`LOHRA_AUDIT_MAX_EVENTS`), 64 runs (`maxRuns`), 64
tombstones (`maxTombstones`), 30 dias / 2 592 000 s (`retentionSeconds`).

- **Por run**, `pruneRun` (`audit-repository.ts:511-530`) apaga as linhas
  mais antigas acima do teto e soma em `retention_dropped`/
  `dropped_before_seq` — `query()` sintetiza isso como um `notice`
  `audit.gap {reason:"retention_limit", dropped_count, before_seq}`; não é
  uma linha gravada, é derivado a cada leitura.
- **Entre runs**, `pruneRuns` (`audit-repository.ts:532-553`) evicta o run
  menos recentemente tocado (`touch_order`) acima de `maxRuns`, e
  `compact` (`audit-repository.ts:555-573`) evicta por tempo — os dois
  deixam um tombstone (`run_limit`/`retention_time`) em vez de apagar sem
  rastro; uma consulta a esse run devolve `audit.unavailable
{reason:<motivo do tombstone>}`. Os próprios tombstones são capados em
  `maxTombstones`, os mais antigos descartados primeiro.

## O que NÃO é garantido

- Uma tool call cujo assentamento real (`onToolSettled`) chega **depois**
  do evento terminal do seu leaf não grava o desfecho real
  (`success`/`error`): `close()` já removeu a entrada de `open` e já
  fechou o par como `tool.completed {status:"error", reason:"cancelled"}`
  antes do terminal do leaf (`close()`, `audit-runtime.ts:239-266`, #378);
  `onToolSettled`, ao rodar depois, encontra `open.get(leaf.subId)`
  `undefined` e não grava nada — nem decrementa nada
  (`onToolSettled`, `audit-runtime.ts:483-501`). O par nunca fica órfão (sempre há um
  `tool.completed` para todo `tool.started`), mas o resultado real de uma
  tool que só assenta depois do cancelamento do seu leaf não chega ao
  ledger.
- `workflow_audit` só lê linhas já commitadas; `AuditTrail.record` apenas
  enfileira (`audit-trail.ts:59-118`). A tool que o agente chama espera até
  `AUDIT_READ_FLUSH_TIMEOUT_MS` (250 ms) o dreno antes de ler e nomeia o
  que sobrou em `integrity.pending` (#373; ver "`integrity.pending`"
  acima) — mas o prazo é curto de propósito (invariante 3, nunca espera
  sem teto) e uma leitura ainda pode voltar sem alguns eventos recém
  produzidos, só que agora nomeados em vez de silenciosos. Um `AuditTrail`
  já `stopped` com a fila vazia não seta `pending` nenhum, mesmo perdendo
  eventos dali em diante.
- `refused_writes` é por instância de `AuditRepository`, em memória — não
  sobrevive a um reinício do processo, e um run evictado do LRU volta a
  zero na consulta seguinte.

## Mutação

A fatia `workflow-audit-live` (`npm run mutations:t17`, 57 mutantes:
`workflow-audit-live-mutants.ts` com 32 + `workflow-audit-producers-mutants.ts`
com 25, issues #370 e #383) cobre a identidade causal, a regra fail-closed, o
`flush` antes da liberação do lease, o ciclo de segmento/crash, o terminal
único por `sub_id` — inclusive o `tool.completed {reason:"cancelled"}` do
`close()` —, a classificação de uma recusa de sandbox, hit/miss de cache
relatados errado, e os tetos/cursor do live tail — inalterada por #460/#461
(M11): `node.rerouted` e o `reason`/`version_state` novos de `cache.*` são
cobertos por `t15`/`t16` (`src/workflow/**`), não por esta fatia. Catálogo
completo, contagem (256 no total, entre as nove fatias — t15 45, issue #418)
e o que ficou deliberadamente fora em `docs/mutation-testing.md`.

## Ver também

`docs/operator-notices.md` — o canal de avisos duráveis ao operador
(`operator_notices`), irmão deste ledger mas para "isto aconteceu e alguém
precisa ver", não para a trilha de execução por nó.
