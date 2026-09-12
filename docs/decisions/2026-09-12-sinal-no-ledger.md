# Sinal no ledger: `reason: signal` distingue SIGTERM/SIGINT de `workflow_cancel`

- **Data:** 2026-09-12
- **Origem:** issue #428 (M10-S7, épico #421 "Supervisão em voo"); decisão 5
  do mapa do épico (`reason: signal` na allow-list, não um `event_type`
  próprio).

## Contexto

Antes desta issue, um SIGTERM ou SIGINT e um `workflow_cancel` chegavam ao
mesmo lugar: `WorkflowService.shutdown()` (`src/workflow/service.ts:1207` na
base) e `cancel(runId)` convergiam em `cancelAndSettle` → `engine.cancel()` →
status `"cancelled"` (`engine.ts:148,415`), e `announceStretchEnd` gravava
`segment.completed {status: "cancelled", terminal: true}` sem nada que
dissesse qual dos dois caminhos produziu o evento. Só SIGINT tinha handler —
`src/commands/serve.ts:156` (o `off`, :135) e `src/commands/dashboard.ts:485`
— SIGTERM (o sinal que um orquestrador ou gerenciador de processo manda
primeiro) não tinha handler nenhum neste código.

## Decisão

- `src/cli/shutdown-trigger.ts` (novo): `registerShutdownTrigger(handler,
target?)` registra um wrapper interno, `wrapped` (`shutdown-trigger.ts:44-49`),
  para `SIGTERM` e `SIGINT` via `process.once` (nunca `process.on` — uma
  segunda entrega do MESMO sinal cai no comportamento padrão do Node,
  não dispara duas vezes) e devolve `unregister`. Desde a issue #434,
  `wrapped` chama `unregister()` — removendo os dois listeners — ANTES de
  chamar o `handler` do caller, então uma segunda entrega — do mesmo sinal
  OU do outro — nunca dispara `handler` duas vezes. `serve.ts` e
  `dashboard.ts` passam a usá-lo; `dashboard.ts` mantém
  `options.registerShutdownTrigger` injetável para teste, agora cobrindo os
  dois sinais também no caminho real (o default deixou de ser só
  `process.once("SIGINT", handler)`).
- `WorkflowService.shutdown(reason: "signal" | "operator" = "operator")` —
  a causa atravessa `runShutdown` → `cancelAndSettle` (que marca
  `RunRecord.interruptCause = "signal"` em cada run vivo antes de
  cancelá-lo) → `announceStretchEnd` → `announceSegmentCompleted`
  (`audit-producers.ts`). Um shutdown por sinal grava `segment.completed
{status: "interrupted", reason: "signal"}` — o `status` que o motor
  publica em outros lugares (`resultView`, `service.ts`) continua
  `"cancelled"` sem mudança; só o LEDGER ganha a distinção.
- `cancel(runId)` (a tool `workflow_cancel`) e um `shutdown()` sem sinal
  continuam publicando `status: "cancelled"`, agora com `reason: "cancelled"`
  explícito no payload de `segment.completed` — nunca `reason: "signal"`.
  Antes desta issue esse payload não tinha `reason` nenhum; o valor
  explícito existe para que quem lê o ledger nunca precise inferir "não foi
  sinal" a partir de um campo ausente.
- `"signal"` entra na allow-list `reason` de `audit-model.ts` (`SAFE_STRING_VALUES.reason`).
- Issue #434 (follow-up do veredito da PR #433): `announceSegmentCompleted`
  só aplica `cause: "signal"` quando `status` já é `"cancelled"`/`"interrupted"`
  — um run cuja própria `engine.run()` resolveu durante a janela do
  shutdown (a corrida entre `runShutdown` e o `.then()` de `service.ts:609`)
  nunca grava `reason: "signal"` — e `registerShutdownTrigger` desarma o
  OUTRO sinal antes de invocar o handler, então SIGTERM seguido de SIGINT
  dispara o fechamento uma única vez por registro.

### Comportamento observado: o que a SEGUNDA entrega de sinal faz depois disso

Esta nota não descreve (e a implementação não muda) o que acontece a um
TERCEIRO sinal, ou a um segundo sinal que chega ENQUANTO `handler` ainda
está rodando: `wrapped` já chamou `unregister()` antes de invocar
`handler` (`shutdown-trigger.ts:44-49`), então nenhum dos dois sinais tem
listener nenhum a partir daí — um SIGTERM/SIGINT adicional cai na
disposição padrão do Node (o processo morre imediatamente), não em um
handler nomeado. `handler` (`runShutdown` → `cancelAndSettle` →
`announceStretchEnd`) é assíncrono e, no caminho durável, termina com
`flushBeforeRelease()` antes de liberar o lease do run
(`service.ts:983,1005`) dentro da janela de `SHUTDOWN_SETTLE_TIMEOUT_MS`
(5 s, `service.ts:46`) — um sinal adicional que mata o processo dentro
dessa janela corta esse flush e a liberação do lease no meio, e o lease
some do jeito que já existia antes desta issue: por `RUN_LEASE_TTL` (900
s, `service.ts:41`), não por uma liberação explícita. Não é uma regressão
desta issue nem da emenda #434 — é o mesmo custo que qualquer `kill -9`
já tinha, só que agora alcançável por um segundo `Ctrl-C`/SIGTERM comum
durante o shutdown gracioso.

## Doutrina para autores de spec

Um resume que decide se deve reagir a um run pausado por "abandono do
operador" ou por "ambiente interrompeu o processo" lê `segment.completed`
com `runId`+`segmentId` mais recente do run: `reason: "signal"` é o
processo, não alguém cancelando; `reason: "cancelled"` (com `status:
"cancelled"`) é `workflow_cancel`. Nenhuma outra combinação de
`status`/`reason` distingue os dois caminhos.

## Evidência

- `tests/workflow-shutdown-signal.test.ts`: `shutdown("signal")` com um run
  vivo grava `segment.completed {status: "interrupted", reason: "signal"}`;
  `shutdown()` sem razão e `cancel(runId)` gravam `{status: "cancelled",
reason: "cancelled"}`, nunca `reason: "signal"`; `registerShutdownTrigger`
  com um `process`-fake prova o registro dos dois sinais e o `unregister`,
  sem nunca sinalizar o processo real do vitest.
- `npm run mutations:t16` (60/60) e `npm run mutations:t17` (57/57)
  continuam verdes — nenhum mutante existente foi afetado pela extração de
  `cause`/`interruptCause`.
- Issue #434: `announceStretchEnd("complete", null, null, "signal")`,
  exercitado direto pelos produtores (`createWorkflowAuditProducers`), grava
  `segment.completed {status: "complete"}` sem `reason`; um alvo `SignalTarget`
  fake recebendo SIGTERM e depois SIGINT, sem `unregister()` explícito entre
  os dois, dispara o handler injetado exatamente uma vez.
