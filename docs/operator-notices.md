# Avisos ao operador (`operator_notices`)

Épico #396 (M8), issues #400-#402/#410/#411 (M8-4, M8-5, M8-6, M8-8): o
canal para "isto aconteceu e alguém precisa ver" — distinto do ledger de
auditoria (`docs/workflow-audit.md`), que é a trilha de execução por nó.
Armazenamento (tabelas, `NoticesRepository`, fence, retenção por escopo) em
`docs/state-sqlite.md#operator_notices`; esta página é a camada acima: quem
grava, o vocabulário, e como um agente ou um operador lê de volta.

## Um sink por processo

`createSessionToolBase` (`src/commands/session-tools.ts:68-75`) constrói UM
`NoticesSink` (`createNoticesSink`, `src/workflow/notices-sink.ts`) por
processo — `chat.ts` e `dashboard.ts` reusam essa mesma instância para todo
canal de aviso que já existia antes deste épico: `WorkflowService.onWarning`,
o `warning` de `AuditTrail`/`AuditRepository`, `WorkflowLiveTail`, e o sink
de aviso do ownership store (`productionWarningSink`, para uma
`StateWarning`). Nenhum desses canais ganhou uma segunda escrita a
`console.warn` — o sink chama o `fallback` (que já imprimia) e, além disso,
grava a mesma mensagem em `operator_notices`.

Dentro do próprio `WorkflowService`, o mesmo `this.warn` alimenta
`WorkflowLiveEvents` e `AutoResumeScheduler.logWarning` (issue #411) — não
há mais um canal de aviso de produção que fique de fora do sink. As
exceções são estruturais, não um esquecimento: `lohra workflow list/watch/
audit` (`src/commands/workflow.ts`) é só leitura e nunca detém uma
`WorkflowService`, então usa `productionWarningSink` direto para stderr, sem
gravar em `operator_notices`; e testes que constroem um `WorkflowService`
sem `onWarning` caem no `console.warn` default sem sink nenhum.

### `route_fault`: um segundo produtor, direto no repositório

Issue #426 (M10-S5, épico #421) acrescentou um produtor que NÃO passa pelo
`NoticesSink` por processo acima: `recordRouteFaultNotice`
(`src/workflow/route-faults.ts:124-139`) grava direto num
`NoticesSinkRepository` quando `auth_failed`/`route_fault`/`model_not_found`
pausa um run durável — `scope = "run:<runId>"`, `kind = lesson.error_kind`
(o próprio `ErrorKind` da rota recusada, nunca reclassificado por
`notices-sink.ts`'s `classify()`). Sem repositório configurado, checkpoint
que não é uma `RouteLesson` válida, ou uma escrita recusada/lançada,
cai num `warn` — nunca silencioso (invariante 2), mas também nunca chega a
`operator_notices` nesse caso.

Ligação em produção (3ª emenda da PR #439, rodada 2): `createSessionToolBase`
(`src/commands/session-tools.ts:79,105`) expõe `noticesRepository` — a MESMA
instância que `workflow_notices`/`workflow_notices_ack` já leem — e
`chat.ts`/`dashboard.ts` passam essa instância na chave opcional `notices`
de `productionOwnershipStore` (`src/workflow/ownership-store.ts:55-76`,
consumida em `src/commands/chat.ts:355`,
`src/commands/dashboard.ts:315`) — o `OwnershipStore` que essa função monta
sai com `notices` como sua 7ª propriedade quando presente. Honestamente: é
o MESMO repositório que
este documento descreve para o resto do canal, não um segundo armazenamento
— um operador lendo `workflow_notices RUN_ID` vê o notice de rota junto com
qualquer outro aviso daquele run, sem precisar saber que o produtor não
passou pelo `NoticesSink`.

## Vocabulário (`NoticeKind`)

`NOTICE_KINDS = [...ERROR_KINDS, ...STATE_NOTICE_KINDS]`
(`src/state/notices-repository.ts:18-25`, issue #401): os 9 `ErrorKind` de
`src/transports/error-kinds.ts` (`quota_exhausted`, `auth_failed`,
`model_not_found`, `route_fault`, `sandbox_denied`, `timeout`, `cancelled`,
`context_length`, `unknown` — vocabulário completo em
`docs/workflow-audit.md#vocabulário-de-falhas-error_kind`) mais quatro
específicos deste canal:

| kind                        | quando                                                               |
| --------------------------- | -------------------------------------------------------------------- |
| `stale_fence_write`         | `warnState` — uma escrita perdeu a corrida de fence (`StateWarning`) |
| `audit_sink_failure`        | o sink de auditoria falhou/está fechado/o sanitizador lançou         |
| `resume_attempts_exhausted` | `AutoResumeScheduler` desistiu de retomar um run pausado             |
| `queue_overflow`            | a fila em memória do `AuditTrail` transbordou e descartou um evento  |

Um `kind` fora desse conjunto nunca chega à tabela: `NoticesRepository.append`
recusa (retorna `null`, conta em `refused_writes`, emite um `warning` — nunca
lança e nunca grava fora do vocabulário).

`warn(message: string)` — a metade não tipada do sink — classifica por um
mapa ORDENADO e explícito de substrings literais, primeiro casamento vence
(`KIND_MARKERS`, `notices-sink.ts`), nunca uma regex solta: cada entrada é
a mensagem exata de um produtor real, citada por `arquivo:linha` no próprio
comentário do mapa. Uma mensagem que não casa nenhum marcador cai em
`unknown`. `warnState(warning: StateWarning)` é a metade tipada: sempre
`stale_fence_write`, formatada pelo mesmo `productionWarningSink` que o
`fallback` usa, então as duas nunca divergem de texto.

## Escopo e dono

`append(scope, {kind, message}, ownership?)`:

- `scope = "run:<id>"` exige `ownership` válida e aplica o mesmo predicado
  de dono de fence que `AuditRepository` usa (JOIN sobre
  `workflow_run_fence`/`workflow_run_locks`) — sem dono corrente, recusa.
- `scope = "global"` nunca exige `ownership` — avisos de processo sem run
  associado, e (issue #410) o destino de fallback de um `warnState` cujo
  processo não tem mais (ou nunca teve) a `ownership` do run: em vez de
  perder o aviso, a MESMA mensagem — que já carrega o `run_id` em texto —
  é gravada em `global`. Contado em `stats().fallback_global`, nunca em
  `dropped`: o aviso não se perdeu, só mudou de escopo.

## Leitura: tool e CLI

`workflow_notices` (`src/workflow/notices-tool.ts`,
`workflowNoticesHandler`) lista `NoticesRepository.list()` e devolve o
envelope com `integrity: {refused_writes}` — sem `run_id`, cruza todo run
mais `global`; com `run_id`, só aquele escopo. `""` e `0` nos filtros
opcionais significam ausência, o mesmo idioma que `workflow_audit` já usa
desde #390. `workflow_notices_ack({id})` reconhece um aviso pelo `id`
retornado por `workflow_notices` — `acked: false` para um `id` inexistente
ou já reconhecido, nunca um erro.

`lohra workflow notices [RUN_ID] [--ack ID] [--all] [--after-seq N]
[--json]` (`src/commands/workflow.ts`, branch `"notices"`) é a mesma leitura
pela CLI: `RUN_ID` posicional escopa a `run:<id>`, omitido lista tudo;
`--all` inclui os já reconhecidos; `--ack ID` reconhece e sai (`acked
<id>`/`no notice <id> to ack`); sem `--json`, cada linha é `id  scope  kind
[(acked)]  message`. Ao contrário da tool, o `--json` da CLI imprime a
página crua do repositório, sem o envelope `integrity` (`refused_writes`
vem no topo da página, não aninhado) — README documenta os dois comandos.

## Retenção

256 avisos por escopo (`NOTICES_SCOPE_CAP`, `maxPerScope`): acima do teto,
os já reconhecidos caem primeiro (mais antigos entre eles primeiro); um
não-reconhecido só cai quando não sobra nenhum reconhecido para cair no
lugar. `dropped_before_seq` (por escopo) registra o maior `seq` já podado.
Detalhes de schema e a transação de `append`/`pruneScope` em
`docs/state-sqlite.md#operator_notices`.

## O que NÃO é garantido

- `stats().dropped`/`stats().fallback_global` são contadores em memória, por
  instância de `NoticesSink` — não sobrevivem a um reinício do processo, e
  hoje não são lidos por nenhuma tool ou CLI de produção (só por teste).
- `refused_writes` de `NoticesRepository` é, como o do `AuditRepository`, em
  memória e por instância — some num reinício, e um escopo evictado do LRU
  (`maxScopes`) volta a reportar `0`.
- Um `kind` gravado antes da unificação (#401) que não pertencesse a
  `ERROR_KINDS` nem a `STATE_NOTICE_KINDS` nunca existiu na tabela — a
  validação de `kind` sempre recusou na escrita, não é uma migração
  retroativa.
