# Auditoria por nó: o ledger de eventos do workflow

Comportamento de `src/workflow/audit-model.ts`, `audit-producers.ts`,
`audit-runtime.ts`, `audit-cache.ts`, `audit-trail.ts`, `live-tail.ts` e
`src/state/audit-repository.ts` — épico #364, seis issues mergeadas
(#365 identidade causal, #366 `leaf.*`, #367 `tool.*`, #368 `cache.*`/
`segment.*`/`node.paused`/`audit.gap {process_crash}`, #369 live tail +
`watch --events` + `workflow_status.live_tail`, #380 sink de aviso em
produção).

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

`AUDIT_POLICY` (`audit-model.ts:410-416`), devolvida em toda página de
consulta:

```
mode: "metadata_only"
raw_payloads: "redacted_or_excluded_at_ingest_and_read"
private_reasoning: "excluded_private_state"
provider_calls: "none"
summary_generated: false
```

`LOHRA_AUDIT` decide se o runtime sequer usa a trilha: `off`/`0`/`false`/`no`
desliga (`auditEnabled`, `audit-model.ts:418-435`, lido em
`service.ts:430`); qualquer outro valor reconhecido (`on`/`1`/`true`/`yes`,
ou a variável ausente/vazia) liga; um valor não reconhecido avisa e
**permanece ligado** — nunca desliga por engano. `LOHRA_AUDIT_MAX_EVENTS`
sobrepõe o teto de eventos retidos por run (`resolveAuditSettings`,
`audit-model.ts:437-455`, lido no construtor de `AuditRepository`,
`audit-repository.ts:179-180`); um valor não inteiro ou menor que 1 avisa e
mantém o padrão (2048).

## Identidade causal

Toda gravação carrega `publicAuditIdentity` (`audit-model.ts:389-408`):

| campo        | o que é                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `run_id`     | sempre presente; acima de 128 caracteres vira `<95 chars>~<sha256[:32]>`                            |
| `segment_id` | a aquisição (stretch) que produziu o evento                                                         |
| `node_path`  | **um único elemento** — o nó imediato do evento, clipado a 64 chars; não é a cadeia causal completa |
| `sub_id`     | a sessão do leaf spawnado, quando o evento é sobre um leaf/tool call                                |
| `attempt`    | o número da tentativa do segmento                                                                   |

A cadeia causal inteira (até 8 ancestrais, cada um clipado a 64 chars)
aparece só dentro do `data.node_path` de `leaf.started` — não em
`identity` (`audit-runtime.ts:178`, `audit-model.ts:293-294`).

## Tabela de eventos

Vinte tipos formam a allow-list (`SAFE_EVENT_TYPES`,
`audit-model.ts:104-127`); um `event_type` fora dela vira
`audit.unavailable` na gravação. `node.completed`, `node.failed`,
`node.output` e `node.started` nunca tiveram produtor e saíram da
allow-list em #386 — o ciclo de vida de um nó continua observável só por
`workflow.node` (abaixo), que já existia antes deste épico, e por
`node.paused`, o único membro da família `node.*` que #368 decidiu manter.

| `event_type`        | produtor                                                                                | quando                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `segment.started`   | `announceSegmentStarted` (`audit-producers.ts:230`)                                     | primeiro evento de uma aquisição, antes de `workflow.plan`                                                                                                                 |
| `workflow.plan`     | `announcePlan` (`audit-producers.ts:205`)                                               | logo após `segment.started`; `data.node_path` lista todos os nós do spec                                                                                                   |
| `workflow.node`     | `forwardEvent` (`audit-producers.ts:168`)                                               | a cada evento `node` do engine (running/complete/failed/…)                                                                                                                 |
| `workflow.items`    | `forwardEvent`                                                                          | progresso item-a-item de um `pipeline`                                                                                                                                     |
| `workflow.fault`    | `forwardEvent`                                                                          | um fault do engine                                                                                                                                                         |
| `node.paused`       | `announceNodePaused` (`audit-producers.ts:255`)                                         | run pausado; `payload.reason` ∈ `checkpoint`, `quota_exhausted`, `token_budget_exhausted`, `user_requested` — nunca duplica nem substitui `workflow.node`/`workflow.fault` |
| `segment.completed` | `announceSegmentCompleted`, ou `announceProcessCrash` para a segmento anterior          | fim normal (`status` = `complete`/`paused`/`cancelled`/`failed`) ou, sob retomada de dono morto, o segmento antigo fechado como `interrupted`/`process_crash`              |
| `workflow.done`     | `announceDone` (`audit-producers.ts:225`)                                               | último evento do segmento                                                                                                                                                  |
| `audit.gap`         | vários (ver "Fail-closed" abaixo)                                                       | toda perda nomeada                                                                                                                                                         |
| `audit.truncated`   | `publicAuditEvent` (`audit-model.ts:353-387`)                                           | evento serializado > 2048 bytes (`AUDIT_EVENT_BYTES`)                                                                                                                      |
| `audit.unavailable` | leitura (`parseEvent`/`query`, `audit-repository.ts`)                                   | `event_type` fora da allow-list, payload corrompido no disco, ou run tombado/nunca gravado                                                                                 |
| `leaf.started`      | `auditedChildRuntime.spawn` (`audit-runtime.ts:166`)                                    | um `ChildRuntime.spawn` bem-sucedido                                                                                                                                       |
| `leaf.completed`    | `close()` em `collect()` (`audit-runtime.ts:146,196`)                                   | `collect` volta `status: "complete"`                                                                                                                                       |
| `leaf.failed`       | `close()`                                                                               | `collect` falha/cancela/estoura timeout, ou `cancel()` — sempre exatamente um evento terminal por `sub_id`                                                                 |
| `tool.started`      | `auditedToolDispatch` (`audit-runtime.ts:107`)                                          | toda chamada de tool feita por um leaf                                                                                                                                     |
| `tool.completed`    | `auditedToolDispatch` (recusa síncrona) ou `onToolSettled` (`audit-runtime.ts:117,263`) | `{status:"error", reason:"sandbox_denied"}` para uma recusa síncrona do sandbox; `{status:"success"}`/`{status:"error"}` sem `reason`, do assentamento real                |
| `cache.replayed`    | `auditedWorkflowCache.get` (`audit-cache.ts:51`)                                        | hit de cache                                                                                                                                                               |
| `cache.missed`      | `auditedWorkflowCache.get`                                                              | miss de cache                                                                                                                                                              |
| `cache.stored`      | `auditedWorkflowCache.put` (`audit-cache.ts:61`)                                        | escrita de cache bem-sucedida                                                                                                                                              |
| `cache.unavailable` | `auditedWorkflowCache.put`                                                              | escrita de cache recusada (`payload.reason: "store_failed"`)                                                                                                               |

`tool.started`/`tool.completed` e `leaf.*` compartilham a mesma identidade
(mesmo mapa `open` em `audit-runtime.ts`) — filtrar por `sub_id` devolve um
leaf junto com toda tool que ele chamou.

## Ciclo de um segmento

Uma aquisição (stretch) bem-sucedida, na ordem em que os eventos são
enfileirados (`service.ts:1023-1045`):

```
segment.started {attempt}
workflow.plan
workflow.node / workflow.items / workflow.fault  (zero ou mais)
node.paused {reason}                              (só se o run pausou)
segment.completed {status}
workflow.done {status}
flushBeforeRelease()                              (só no caminho durável)
release do lease
```

O caminho `.catch` do stretch emite `segment.completed {status:"failed"}`
antes de `workflow.done` (`service.ts:1044`). `flushBeforeRelease`
(`audit-producers.ts:288-292`, emenda de #368 em 2026-09-11) drena a fila
do `AuditTrail` **antes** de liberar o lease — sem isso, os três eventos
terminais que `announceStretchEnd` acabou de enfileirar ainda estariam na
fila quando a fence desaparecesse, e `AuditRepository.append` os recusaria
silenciosamente sob uma fence já vencida.

**Retomada de dono morto**: quando `WorkflowService.start` detecta um run
`orphaned` (status `running`, lease sem dono vivo, `service.ts:706-710`),
adquire uma fence nova e, antes de iniciar o segmento novo, fecha o
segmento anterior sob essa fence nova:

```
segment.completed {status:"interrupted", reason:"process_crash"}   — nomeando o segmento ANTIGO (ou nenhum, para um run durável de antes de #365)
audit.gap {reason:"process_crash", count_state:"unavailable"}       — sem segment_id, sem dropped_count
```

(`announceProcessCrash`, `audit-producers.ts:243-253`; chamado em
`service.ts:929`). Distinto de `audit.gap {reason:"sink_failure"}` — o
único outro produtor de `audit.gap` fora da família de recusas do
`AuditTrail`/retenção.

## Fail-closed (invariante 4)

`recordAuditEvent` (`audit-producers.ts:134-147`) é a regra que todo
produtor deste código compartilha: se `trail` não existe, é um no-op; numa
aquisição durável cuja `ownershipOf()` já voltou `null`, o evento é
**descartado** com um `warn` nomeado, sem sequer chegar ao `AuditTrail` —
nunca gravado sem fence.

`AuditRepository.append` (`audit-repository.ts:186-298`) confere a fence
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
`launchDurable` (`service.ts:653`); esse caminho é só para teste.

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
  `events`, nunca `notices`. `""` (nos quatro campos de string, após trim)
  e `attempt: 0` significam filtro AUSENTE, não um valor a bater — a mesma
  query que omitir o campo (`parseAuditQuery`, `audit-query.ts`, #390).

Um run sem `workflow_audit_state` e sem tombstone devolve
`availability:"unavailable"` com um único `notice` `audit.unavailable
{reason:"not_recorded"}`.

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
devolve `live_tail: {events, next_cursor, dropped}` (`tool.ts:96`).
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
agente usa.

## Retenção

Padrões (`audit-model.ts:4-8`, sobrepostos por `AuditRepositoryOptions`):
2048 eventos por run (`LOHRA_AUDIT_MAX_EVENTS`), 64 runs (`maxRuns`), 64
tombstones (`maxTombstones`), 30 dias / 2 592 000 s (`retentionSeconds`).

- **Por run**, `pruneRun` (`audit-repository.ts:474-493`) apaga as linhas
  mais antigas acima do teto e soma em `retention_dropped`/
  `dropped_before_seq` — `query()` sintetiza isso como um `notice`
  `audit.gap {reason:"retention_limit", dropped_count, before_seq}`; não é
  uma linha gravada, é derivado a cada leitura.
- **Entre runs**, `pruneRuns` (`audit-repository.ts:495-516`) evicta o run
  menos recentemente tocado (`touch_order`) acima de `maxRuns`, e
  `compact` (`audit-repository.ts:518-536`) evicta por tempo — os dois
  deixam um tombstone (`run_limit`/`retention_time`) em vez de apagar sem
  rastro; uma consulta a esse run devolve `audit.unavailable
{reason:<motivo do tombstone>}`. Os próprios tombstones são capados em
  `maxTombstones`, os mais antigos descartados primeiro.

## O que NÃO é garantido

- Uma tool call que assenta **depois** do evento terminal do seu leaf (o
  `close()` já removeu a entrada de `open`) não produz `tool.completed`
  nenhum — `auditedToolDispatch`/`onToolSettled` procuram por `sub_id` num
  mapa que já não o tem (`audit-runtime.ts:99,264-265`). Território de
  #378 (testes de `tool.*`, e possivelmente `tool.completed
{reason:"cancelled"}` no `close()` de `cancel()`).
- `workflow_audit` só lê linhas já commitadas; `AuditTrail.record` apenas
  enfileira (`audit-trail.ts:59-118`) — uma consulta no mesmo turno em que
  um evento acabou de ser produzido pode não vê-lo ainda, sem drenagem
  síncrona. Território de #373 (drenagem in-turn).
- `refused_writes` é por instância de `AuditRepository`, em memória — não
  sobrevive a um reinício do processo, e um run evictado do LRU volta a
  zero na consulta seguinte.
- A tabela de mutantes desta fatia pode crescer — #383 é o rastro.

## Mutação

A fatia `workflow-audit-live` (`npm run mutations:t17`, 50 mutantes:
`workflow-audit-live-mutants.ts` com 32 + `workflow-audit-producers-mutants.ts`
com 18, issue #370) cobre a identidade causal, a regra fail-closed, o
`flush` antes da liberação do lease, o ciclo de segmento/crash, o terminal
único por `sub_id`, a classificação de uma recusa de sandbox, hit/miss de
cache relatados errado, e os tetos/cursor do live tail. Catálogo completo,
contagem e o que ficou deliberadamente fora em `docs/mutation-testing.md`.
