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
`model_not_found`, `route_fault`, `sandbox_denied`, `timeout` (reservado; sem
produtor hoje — ver
`docs/decisions/2026-09-14-kind-timeout-reservado.md`), `cancelled`,
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
- `scope = "session:<id>"` (issue #589) nunca exige `ownership`, mesmo
  predicado de `global` — uma sessão de chat não tem fence/lock de run, e
  `run:<id>` é sempre um `workflow_run_state.run_id`, um namespace TOTALMENTE
  disjunto do id de uma sessão de chat. Existe para o overlay de avisos no
  turno (próxima seção), nunca para um workflow run.

## Entrega no turno, sem tool call (issue #589)

`ConversationRuntime.runTurn` (`src/conversation/runtime.ts`) opcionalmente
recebe um `notices: TurnNoticesPort` (`src/context/notices-overlay.ts`,
`createTurnNoticesPort`, wireado em `chat.ts`/`dashboard.ts` sobre o MESMO
`noticesRepository` que `workflow_notices` já lê). Ausente, o turno é
byte-idêntico a antes desta issue existir — todo teste anterior a #589
nunca passa essa opção. Issue #608 (épico #575 P13, "toda superfície")
acrescenta o mesmo campo opcional a `GatewayWsDeps`
(`src/gateway/ws/connection.ts`) — o único `ConversationRuntime` construído
sob o gateway WS (`handlePromptSubmit`, um turno por `prompt.submit`) também
sabe encaminhar o overlay quando o campo é populado. Issue #651 (sub-issue
C1 de #637) fia o caller de produção: `dashboard.ts` (o único que constrói
`GatewayWsDeps`) passa a MESMA `createTurnNoticesPort` instance que o job
runner do cron já usava (hoisteada uma vez, compartilhada entre as duas
superfícies) — um aviso pendente chega a QUALQUER turno do dashboard hoje,
cron ou WS. `serve` (`src/server/service.ts`) continua sem overlay: não
tem `state.db` nem `LineageSource` (`RequestRepository` constrói um
`ConversationRuntime` por request, sem sessão persistida) — se `serve`
algum dia ganhar estado, o overlay entra junto; até lá é a única superfície
de turno sem essa fiação, não um gap silencioso.

Presente, em toda chamada a `runTurn`:

1. **Claim** (`claimLineageNotices`), no início do turno: lê os avisos
   PENDENTES (não reconhecidos) do escopo `global` mais `session:<id>` para
   cada `id` que `SessionRepository.lineageRootToTip(sessionId)` devolve (a
   própria sessão e cada ancestral, subagentes de `spawn_session`/
   `delegate_task` incluídos). Nunca lê `run:<id>` — um workflow run pausado
   por rota (`docs/workflow-audit.md#route_fault`) fica de fora do overlay
   até existir um vínculo run→sessão; o caso de eval de pausa-por-rota do
   épico #575 P13 depende desse vínculo, ainda não construído.
2. **Format** (`formatNoticeOverlay`): até 4.096 chars, cabeçalho
   `OPERATOR NOTICES (not the user speaking):` e marcador de fim; o que não
   coube fica de fora — nem no texto anexado, nem no `token` de ack, então
   permanece pendente para o próximo claim. Issue #608: a mensagem de cada
   aviso é escapada primeiro — um `message` que contenha, literalmente, a
   substring `"OPERATOR NOTICES"` (presente nos dois marcadores) tem um
   zero-width space inserido no meio, então uma mensagem forjada por um
   provedor ou por conteúdo externo não pode simular o fim do bloco.
3. O bloco é anexado ao CONTEÚDO da mensagem do usuário do turno (nunca ao
   `systemPrompt` — a doutrina de P3/P4 já trata blocos do operador como não
   sendo fala do usuário; aqui o cabeçalho reforça o mesmo texto) — e SÓ para
   as chamadas ao modelo DESTE turno. Issue #608: `commitTurn` persiste o
   `input` cru do usuário, sem o bloco — um aviso já reconhecido (acked) não
   reaparece na história de um turno seguinte da mesma sessão; sem essa
   separação, o overlay virava parte permanente do histórico e era reenviado
   ao modelo em todo turno seguinte, mesmo já consumido.
4. **Ack**, só depois de `commitTurn` gravar o turno: qualquer falha antes
   disso — incluindo o próprio `commitTurn` lançando — pula direto para o
   `catch` de `runTurn`, que nunca chama `ack` — o aviso claim(ado) e não
   confirmado reaparece no próximo claim exatamente como se este turno nunca
   tivesse rodado (leitura sem lock: não há nada para liberar explicitamente).
5. Turno morto (`turn.failed`): `publishFailure` grava um aviso em
   `session:<sessionId>` com `kind` mapeado do `code` do erro pelo
   vocabulário `NoticeKind` congelado (`CONTEXT_WINDOW_EXCEEDED` →
   `context_length`, `CONVERSATION_CANCELLED` → `cancelled`). Issue #608:
   quando o código não tem mapeamento exato (`MODEL_CALL_FAILED`,
   `MAX_ITERATIONS`, o `TURN_FAILED` genérico), `buildTurnNotice` ainda tenta
   `classifyProviderError` sobre a causa de provedor que a própria
   `ConversationTurnFailedError` carrega (`.cause`, um nível abaixo do erro
   que chega em `publishFailure`) — um turno morto por 5xx/`ECONNRESET`/
   `ECONNREFUSED`/`ENOTFOUND` grava `route_fault`, por `429`/código de quota
   grava `quota_exhausted`, em vez de sempre `unknown`. `unknown` só quando
   NEM o código exato NEM a causa classificam algo. O PRÓXIMO turno da mesma
   sessão é quem vê esse aviso, via claim.

Toda operação do `TurnNoticesPort` falha aberta: um repositório de avisos
quebrado nunca falta um turno que não tinha nada a ver com ele — só emite um
`warning` (nunca silencioso, invariante 2).

## Frame WS `compaction.aux_fallback` (issue #671)

Vizinho do overlay acima (mesma superfície, o turno WS da gateway), mas um
canal DIFERENTE: não é um `operator_notices` persistido, é um frame de
evento no PRÓPRIO socket, para o cliente que está olhando o turno agora —
mais perto de "Compactação e título pelo `AuxClient` (issue #587)" em
`docs/context-compaction.md` (mecanismo) do que do resto desta página.
Registrado aqui porque não existe `docs/gateway*.md` e porque este
documento já é onde a fiação de `GatewayWsDeps`/
`src/gateway/ws/connection.ts` é descrita (seção anterior).

`ConversationRuntime.runTurn` (`src/conversation/runtime.ts`) emite
`"compaction.aux_fallback"` (`code` = `error.name` da falha, ex.:
`ProviderCallFailed`, `Error`) sempre que um `options.summarize` injetado
(um `AuxClient.summarizer()`, normalmente) lança durante a compactação —
o turno cai para o summarizer default do próprio transporte
(`summarizeWithFallback`, `src/agent/aux.ts`) e continua, nunca falha por
causa disso (fail-open, issue #587). Antes da #671, esse evento tinha dois
consumidores: `commands/chat.ts` (uma linha em stderr,
`event: compaction.aux_fallback code=...`) e o teste de unidade de
`runtime.ts` — nenhum caminho de produção sob a gateway WS o via.

A issue #671 acrescenta um terceiro: `GatewayEventName`
(`src/gateway/rpc/frame.ts`) ganha `"compaction.aux_fallback"` como
entrada ADITIVA ao vocabulário fechado do socket (`gateway.ready`,
`session.info`, `message.*`, `tool.*`, `session.forked` continuam
exatamente como estavam), e o `eventSink` que `handlePromptSubmit`
(`src/gateway/ws/connection.ts`) passa ao `ConversationRuntime` do turno
encaminha esse evento como frame:

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "type": "compaction.aux_fallback",
    "session_id": "<sessionId>",
    "payload": { "code": "ProviderCallFailed" }
  }
}
```

Ausente `options.summarize` (perfil sem `defaultAuxModel`), ou presente e
bem-sucedido, este frame nunca aparece — byte-idêntico a todo turno WS
anterior à #671. Presente e o auxiliar falha, é o ÚNICO sinal na UI
interativa de que a compactação daquele turno degradou para o modelo do
próprio turno — antes desta issue, o mesmo turno completava normalmente e
a falha só existia no stderr do CLI (`commands/chat.ts`), nunca na
gateway WS que o dashboard usa. Prova em
`tests/gateway/dashboard-ws-overlay.test.ts` (`prova/aux-fallback-ws.ts`):
um `AuxClient` real, com o stub HTTP do teste respondendo erro só ao
request de resumo (por `model`, o único jeito de distinguir a chamada do
`AuxClient` da chamada do próprio turno sem alterar `src/agent/aux.ts`).

## Leitura: tool e CLI

`workflow_notices` (`src/workflow/notices-tool.ts`,
`workflowNoticesHandler`) lista `NoticesRepository.list()` e devolve o
envelope com `integrity: {refused_writes}` — sem `run_id`, cruza todo run
mais `global`; com `run_id`, só aquele escopo. `""` e `0` nos filtros
opcionais significam ausência, o mesmo idioma que `workflow_audit` já usa
desde #390. `workflow_notices_ack({id})` reconhece um aviso pelo `id`
retornado por `workflow_notices` — `acked: false` para um `id` inexistente
ou já reconhecido, nunca um erro. Issue #652: sem `run_id`, esta tool NUNCA
inclui `session:*` (`NoticesListQuery.includeSessions` fica no default
`false`) — o namespace de uma sessão de chat (issue #589) é disjunto de
`run:<id>`, e o modelo de um run não tem por que ver o aviso de um turno
morto de outra sessão de chat no mesmo `state.db`.

`lohra workflow notices [RUN_ID] [--ack ID] [--all] [--after-seq N]
[--json]` (`src/commands/workflow.ts`, branch `"notices"`) é a mesma leitura
pela CLI: `RUN_ID` posicional escopa a `run:<id>`, omitido lista tudo —
inclusive `session:*` (esta branch passa `includeSessions: true`
explicitamente, mantendo o contrato pré-#589 para o OPERADOR, ainda que a
tool acima tenha deixado de fazer o mesmo); `--all` inclui os já
reconhecidos; `--ack ID` reconhece e sai (`acked <id>`/`no notice <id> to
ack`); sem `--json`, cada linha é `id  scope  kind [(acked)]  message`. Ao
contrário da tool, o `--json` da CLI imprime a página crua do repositório,
sem o envelope `integrity` (`refused_writes` vem no topo da página, não
aninhado) — README documenta os dois comandos.

`created_at` e `acked_at` são segundos desde a época Unix, fracionários
(`Date.now() / 1_000`, a mesma unidade e precisão dos dois — coluna `REAL`
nas duas, `src/state/schema.ts`). Issue #603: até essa correção, a leitura
de `acked_at` passava pela conversão de coluna `INTEGER` (`rowNumber`),
que zera qualquer valor com fração — um aviso reconhecido voltava com
`acked_by` preenchido e `acked_at: 0` na tool e na CLI. Issue #652 (veredito
PR #635): a conversão anterior (`Number(...)` cru) devolvia `NaN` em
silêncio para um `acked_at` ilegível gravado por fora desta classe — `NaN`
serializa como `null` em JSON, então o dado corrompido desaparecia sem
rastro. `nullableRowReal` (`src/state/notices-repository.ts:137-149`,
usada por `parseNoticeRow`) checa `Number.isFinite` e, quando falha, emite
um `warning` (`notices: acked_at ilegível na linha <id>`) antes de devolver
`null` — o mesmo valor público de "nunca reconhecido", mas com a causa
registrada. Um `acked_at` fracionário legítimo (issue #603) continua
intacto.

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
