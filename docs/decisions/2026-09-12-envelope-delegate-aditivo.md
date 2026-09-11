# Envelope de `delegate_task` cresce no fim; `dead_turn` é kind próprio

- **Data:** 2026-09-12
- **Origem:** issue #429 (M10-S8, épico #421 "Supervisão em voo"); decisão 3
  do mapa do épico (envelope aditivo, precedente #232).

## Contexto

Antes desta issue, `delegate_task` devolvia por tarefa só `{sub_id, status,
summary}` (`src/orchestration/core.ts` `DelegateOutcome`;
`src/orchestration/tools.ts:160-166,176-182` — o envelope de fato pinado em
`tests/orchestration-tools.test.ts:282-303,330`), enquanto `core.delegate`
já tinha o `CollectResult` completo (`core.ts:230-238`, antes de #429) e
descartava tudo além dessas 3 chaves. Um chamador que precisava de
`error_kind`/tokens/`provider`/`model` por tarefa tinha que fazer uma
segunda chamada, `collect_session`, por `sub_id`. Separadamente, um turno
final sem texto e sem tool call chegava com `errorKind: null`
(`child-runner.ts`, `ERROR_KINDS` sem valor para esse caso) — o motor já
trata a saída vazia como gatilho de respawn (`isEmptyOutput`, `engine.ts`),
mas nada nomeava a falha para quem lê `fault_kinds`/auditoria.

## Decisão

- `ERROR_KINDS` (`src/transports/error-kinds.ts`) ganha um 10º valor,
  `dead_turn`, **no fim** da lista (9 → 10) — nunca reordenado, nunca
  inserido no meio. Propaga automaticamente para `ERROR_KIND_SET`
  (allow-list de auditoria, `audit-model.ts:184`, sem tocar o arquivo) e
  `NOTICE_KINDS` (`src/state/notices-repository.ts`, também sem tocar —
  ambos já derivam de `ERROR_KINDS` por spread).
- `dead_turn` é produzido só em `child-runner.ts`: `content.trim() === ""`
  **e** nenhum tool call executado no turno inteiro. Nunca por
  `classifyProviderError` — `unknown` continua reservado a um
  `ProviderCallFailed` sem mapeamento fino. `status` continua `complete` e
  `output` continua o texto bruto (vazio ou só espaço) — o kind só nomeia o
  que já acontecia, não muda o que o motor faz com o turno.
- `DelegateOutcome` (`core.ts`) ganha `errorKind, tokensIn, tokensOut,
provider, model`, copiados do `CollectResult` que `core.delegate` já
  produzia; `delegateTaskTool` (`tools.ts`) acrescenta `error_kind,
tokens_in, tokens_out, provider, model` **no fim** de cada item de
  `results` — nos dois caminhos que constroem esse array (o batch de
  `core.delegate` e o resume via `steer`+`collect`) — mantendo as 3 chaves
  originais (`sub_id, status, summary`) intactas e primeiro, na mesma ordem.

### Por que aditivo, não um ADR novo

ADR 0003 (`docs/adr/0003-native-wire-format.md:55`) fixa a ordem de
inserção do wire format; "What does not change" (:87-89) e "Revisit
triggers" (:165-166) tratam mudar nome/semântica de um campo existente como
gatilho de ADR novo — acrescentar chave no fim não é isso. #232
(`usage_uncertain` no fim de `collect_session`) já estabeleceu o precedente:
uma chave nova no fim de um envelope de wire format é uma mudança aditiva,
sem ADR. Remover ou reordenar uma chave do envelope de `delegate_task`
(por exemplo, apagar `forced_fallback`) continua fora de escopo — issue
#419, que exige ADR.

## Doutrina para autores de spec

- Um chamador de `delegate_task` que precisa decidir o próximo passo por
  tarefa (retry, trocar de rota, aceitar o resultado) lê `error_kind` no
  próprio item de `results` — não precisa mais de um `collect_session` por
  `sub_id` só para isso.
- `error_kind: "dead_turn"` nunca significa que o turno falhou no sentido de
  "provedor recusou" — `status` permanece `complete`. É o mesmo sinal que já
  disparava um respawn silencioso; agora tem nome e chega a
  `RunResult.faultKinds` (`accounting.ts`'s `recordFaultKind`, via
  `orchestration-runtime.ts:256` → `engine-utils.ts`'s `debitLeaf`) como
  qualquer outro `error_kind` de uma folha do workflow — **não** na
  trilha de auditoria por evento: `leaf.completed` (`audit-runtime.ts:242-251`,
  o branch `status: "complete"`) nunca carrega `error_kind`; só
  `leaf.failed` (`status: "failed" | "cancelled"`) carrega, e `dead_turn`
  nunca tem esses status. Quem lê `error_kind` de um turno morto lê
  `fault_kinds`/`workflow.done` ou o próprio envelope de
  `delegate_task`/`collect_session`, nunca um evento `leaf.*`.
- Um novo campo em `delegate_task`/`collect_session` entra sempre no fim do
  objeto — nunca antes de um campo existente, nunca substituindo um.

## Evidência

- `tests/transport-error-kinds.test.ts`: `EXPECTED_KINDS` (lista literal)
  9 → 10, com `dead_turn` por último.
- `tests/orchestration-tools.test.ts`: os dois pinos byte-exatos do
  envelope de `delegate_task` (batch e resume) repinados 3 → 8 chaves.
- `tests/orchestration-delegate-envelope.test.ts` (novo): as 8 chaves nas
  posições certas com valores de um `CollectResult` fake; `dead_turn` via
  `createChildRunner` real com HTTP fake devolvendo `content` vazio (e,
  separadamente, só espaço em branco), nunca `unknown`; um turno com texto
  real, e um turno com `content` final vazio mas que já executou uma tool
  call, continuam com `error_kind: null` (o guard exige as duas metades:
  sem texto **e** sem tool call); `dead_turn` aceito pelo MECANISMO da
  allow-list de auditoria (`ERROR_KIND_SET`, via `publicAuditEvent`) — não
  uma prova de que produção emite `leaf.failed` com `dead_turn` (nunca
  emite, ver acima).
