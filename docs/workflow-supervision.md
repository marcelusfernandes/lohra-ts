# Supervisão em voo: `workflow_steer`, `workflow_leaf_read`, pivô de rota

Épico #421 (M10 "Supervisão em voo"), dez sub-issues mergeadas em
`main` — três ferramentas/capacidades que deixam um operador (ou o próprio
agente que orquestra) intervir num `run_workflow` já em execução, sem
esperar ele falhar ou pausar sozinho. Este documento é o resumo operacional;
o comportamento medido e a doutrina de cada decisão estão nas notas em
`docs/decisions/` linkadas abaixo, e o vocabulário do ledger (`leaf.steered`,
o 5º `pause_reason`) está em [`docs/workflow-audit.md`](workflow-audit.md).

## `workflow_steer` — mensagem ao vivo para um leaf em execução (#424, M10-S3)

Entrega uma mensagem de operador ao próximo turno de um leaf que já está
rodando, sem esperar ele falhar ou fazer uma pergunta. Nomeia o leaf com
EXATAMENTE UM de `node_id` (resolvido contra os leaves vivos do run agora —
nunca um já terminado) ou `sub_id` (de um evento `leaf.started` em
`workflow_audit`, para desambiguar um fan-out com mais de um leaf vivo no
mesmo nó). `run_id` inexistente, `node_id` sem leaf vivo, `sub_id` que não é
leaf vivo deste run, ou `node_id` ambíguo (mais de um leaf vivo no mesmo nó)
voltam como erro nomeado, nunca um no-op silencioso
(`src/workflow/steer-tool.ts:127-150`).

- **Teto por leaf**: `MAX_PENDING_STEERS_PER_LEAF = 10`
  (`src/orchestration/core.ts:26`) — acima disso, `core.steer` recusa com
  `refused: "steer_cap"` em vez de enfileirar mais um texto que o leaf talvez
  nunca leia (`core.ts:320-326`); `workflow_steer` traduz isso num erro
  nomeado citando o teto (`steer-tool.ts:56,192`).
- **A mensagem nunca vai ao ledger** — só o tamanho: `leaf.steered`
  (`docs/workflow-audit.md`) carrega `payload.message_chars`, nunca o texto
  (`audit-runtime.ts:363-369`). `payload.source` é `"operator"` para todo
  steer que passa por esta tool (`steer-tool.ts:180`, 4º argumento do
  decorador) — distinto de `"engine"`, o steer interno de retry de schema
  (`engine.ts:309-313`).
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

## Pivô de rota: `run_workflow(resume_run_id=..., route={provider?, model?})` (#426/#427, M10-S5/S6)

Um run pausado com `pause_reason: "route_fault"` (5º valor — auth/roteamento/
modelo recusou um leaf, nunca quota; ver
[`docs/decisions/2026-09-12-pausa-por-recusa-de-rota.md`](decisions/2026-09-12-pausa-por-recusa-de-rota.md))
carrega uma lição estruturada (`lesson`) e pode ser retomado numa rota
DIFERENTE:

- `route` só é aceito junto de `resume_run_id`; reescreve `provider`/`model`
  em todo nó (e stage de `pipeline`) da espec PERSISTIDA do run que já
  declara uma rota — um nó que nunca declarou rota nenhuma nunca é tocado.
- **Chave de cache conservadora**: um nó PINADO (que declara rota) recomputa
  na rota nova; um nó sem pino continua replayando do cache
  (`cache.replayed`) — o pivô nunca invalida trabalho que não dependia de
  rota.
- **O pivô PERSISTE**: a espec reescrita é gravada de volta no `spec_json`
  a cada escrita terminal — um resume posterior sem `route` continua na
  rota nova.
- **Teto de 3 pivôs por run** (`MAX_ROUTE_PIVOTS_PER_RUN`,
  `src/workflow/route-override.ts:20`) — cada resume com `route` aceito
  consome um, mesmo que a folha se recuse de novo na rota nova; o 4º é
  recusado com erro nomeado, um gate humano de facto.
- **Sub-workflow por `ref` fica fora do pivô** — carregado em runtime por
  `runNested` (`src/workflow/engine.ts:832-848`), nunca pela espec
  reescrita do run pai.

Detalhe completo (o que cada pivô registra, o que fica de fora, a decisão
de não fazer re-key global) na nota de decisão linkada acima.

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
