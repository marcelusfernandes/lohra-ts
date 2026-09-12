# Abort em voo: três itens resolvidos por observação, um ainda aberto

- **Data:** 2026-09-13
- **Origem:** issue #519 (M16-S4, épico #490, última sub-issue da milestone
  "Abort de stream em voo"); fecha os quatro itens que
  `docs/adr/0005-abort-de-stream-em-voo.md` (seção "Decision", "A definir na
  decomposição do #490") deixou para a implementação decidir.

## Contexto

A ADR 0005 (aceita 2026-09-13, baseline `f631a2ba`) permitiu abort em voo
para os três gatilhos já ligados a um `AbortSignal` — cancel, steer e
timeout — mas deixou quatro perguntas explicitamente sem resposta. As
sub-issues S1-S6 do épico #490 (mergeadas antes desta, #519) resolveram três
delas por código, verificável no HEAD; a quarta segue genuinamente aberta —
o comportamento observado hoje CONTRADIZ a leitura literal da regra do owner
citada pela própria ADR.

## Decisão (D1-D3 — observado, não apenas prometido)

**D1 — fórmula de estimativa de tokens parciais.** `estimatePartialUsage`
(`src/context/token-estimate.ts:222-238`) cobra `partial.text` no fator de
prosa `TEXT_CHARS_PER_TOKEN = 2.9` (`token-estimate.ts:20`) e
`reasoningChars + toolArgumentChars` no fator mais denso
`JSON_CHARS_PER_TOKEN = 2.4` (`token-estimate.ts:29`) — a mesma divisão que
`blockTokens` já usa para uma mensagem completa. `inputTokens` usa
`partial.usage.inputTokens` quando presente e maior que zero — hoje só a
Anthropic preenche isso, via `message_start` (`anthropicPartialUsage`,
`src/transports/errors.ts:169-181`) — e cai para a estimativa de request
(`estimateRequestTokens`) em qualquer outro caso, inclusive quando
`message_start` chegou sem `usage` (tratado como "não medido", nunca como
"custou zero de verdade").

**D2 — `shutdown()` aborta em voo.** `OrchestrationCore.shutdown`
(`src/orchestration/core.ts:451-467`) chama
`entry.abortController.abort()` para TODO child rastreado (linha 453) ANTES
de esperar qualquer um assentar — supera a doutrina "drains, never
abandons" que a ADR 0005 citava como superseded, nas linhas que a ADR
apontava na SUA baseline (`core.ts:99-103`/`:381-390`, pré-implementação).
O texto de produção já foi atualizado para citar a ADR — não é mais um item
pendente: o próprio JSDoc de `shutdown()` (`core.ts:431-443`) e o contrato
de `ChildRunner` (`core.ts:106-113`) já dizem "ADR 0005, issue #518" desde
S3. Um child mid-stream quando `shutdown()` dispara assenta como
`interrupted` com uso estimado, igual a um `cancel()` de leaf único.

**D3 — steer interrompe via um hook armado por chamada, nunca por leaf
inteiro.** `OrchestrationCore`'s `entry.interrupt: (() => void) | null`
(`core.ts:229`) só é não-nulo enquanto uma chamada de provedor está
GENUINAMENTE em voo — `runAndTrack` arma/desarma esse hook a cada chamada
(`interrupts.arm`/o `disarm` que `arm` devolve, `core.ts:499-508`), nunca
uma vez só para a vida inteira do leaf. O hook atravessa `child-runner.ts`
como `interruptSource` até `ConversationRuntime.runTurn`
(`src/conversation/runtime.ts:481-484`), que arma um `AbortController` NOVO
por chamada (`call`, nunca reciclado) — um `steer()` que chega ENTRE
chamadas (leaf rodando uma tool) nunca vê hook vivo e só enfileira
(`core.ts:369-373`), nunca interrompe nada.

## A definir — ainda aberto: `error_kind`/`reason` para os três gatilhos

O comentário do owner citado pela ADR 0005 (issue #465) diz `error_kind:
"cancelled"` **para os três gatilhos**, com o gatilho distinguível por
algum outro campo (a ADR não fixa qual — a leitura natural é `reason`, já
que `audit-runtime.ts` já usa esse campo para `"cancelled"`/`"timeout"`
desde antes desta milestone). O HEAD não implementa isso uniformemente:

- **cancel (S3):** sempre `error_kind: "cancelled"`, `reason: "cancelled"`
  — via `failedPayload(null, "cancelled")` (`audit-runtime.ts:126-131`) ou
  `failedPayload(settled, "cancelled")` (`audit-runtime.ts:523`), os dois
  chamados só de `cancel()` (`audit-runtime.ts:506-525`).
- **steer-interrupt (S5):** NUNCA fecha o leaf — a chamada interrompida é
  reclassificada e o turno pode continuar e completar
  (`runtime.ts:523-544`, `child-runner.ts:234-236`). O único marcador é
  `interrupted: true` em `leaf.steered` (`audit-runtime.ts:437`); não há
  `error_kind` nem `reason` porque não há `leaf.failed` nenhum nesse
  caminho quando o turno termina completando.
- **timeout de folha (S6, #521):** `OrchestrationChildRuntime.collect`
  devolve `{status: "running", output: null}` quando a folha não assenta
  antes do `deadlineMs` (`orchestration-runtime.ts:357-378`). Quando isso
  alcança `AuditedChildRuntime.collect` sob `wait: true`, o leaf fecha
  DIRETO como `leaf.failed {status: "interrupted", reason: "timeout"}`
  (`audit-runtime.ts:498-502`) — sem `error_kind`, sem `partial`, sem
  `usage` — o mesmo objeto literal de antes desta milestone inteira,
  inalterado por #521. Uma folha que gastou tokens reais antes do timeout
  não tem esse gasto refletido no ledger.

Ninguém decidiu explicitamente manter essa divergência ou fechá-la — o
comportamento apenas não mudou porque nenhuma das seis sub-issues tocou
esse branch específico. Fechar isso (dar a `error_kind: "cancelled"` — ou
um kind próprio — ao timeout de folha, e decidir o que `reason` deveria
valer para steer-interrupt) fica como trabalho futuro, não coberto por
#519 (`## Fora de escopo`: "qualquer mudança em `src/`").

## Doutrina para autores de spec

Quem lê o ledger não pode assumir `error_kind: "cancelled"` para todo
`leaf.failed {status: "interrupted"}` — só o caminho de `cancel()` garante
isso hoje. Um `leaf.failed {reason: "timeout"}` não carrega `error_kind`
nem `usage` confiável (a folha pode ter gasto tokens reais que o ledger não
reflete) — o mesmo limite que `docs/workflow-supervision.md` documenta na
seção "Abort de stream em voo" como "running sem usage". Um `leaf.steered
{interrupted: true}` nunca é, sozinho, evidência de falha — o turno pode
muito bem ter completado normalmente depois da chamada interrompida.

## Evidência

- `tests/context-estimate.test.ts` — `estimatePartialUsage — unidade (issue
#518)`: pina os fatores 2.9/2.4 e a precedência de `message_start` sobre a
  estimativa de request.
- `tests/orchestration-core-shutdown.test.ts` — `shutdown()` abortando um
  child mid-stream.
- `tests/orchestration-steer-interrupt.test.ts` — o hook armado por chamada,
  nunca por leaf inteiro.
- `tests/conversation-runtime-injection.test.ts:341-394` ("an external
  cancel during the same call takes precedence over an armed interrupt")
  — o `interruptSource.arm` deste teste é um fake cujo `abort()` devolvido é
  um no-op (`() => undefined`, nunca chama `call.abort`): o teste prova que
  um cancel EXTERNO sempre vira `ConversationCancelledError`, nunca
  reclassificado como `continue` de steer-interrupt, mesmo com um
  `interruptSource` presente (armado, mas nunca disparado) — não prova a
  corrida "os dois sinais disparam ao mesmo tempo" (isso exigiria um fake
  cujo `abort()` realmente chamasse `call.abort`; nenhum teste hoje exercita
  esse caso). A precedência do `signal` externo sobre `call` NESSA corrida
  específica é lida direto do código — a ordem de checagem do `catch`
  (`isAbortOf(error, signal)`, `runtime.ts:509`, antes de
  `signalAborted(call.signal)`, `runtime.ts:531`) — não confirmada por
  teste.
- `tests/workflow-audit-leaf.test.ts:334-349` — `a leaf timeout (wait:true
collect returning running) closes ONCE as interrupted/timeout`: mostra o
  payload `{status: "interrupted", reason: "timeout"}` sem `error_kind`,
  comportamento inalterado por #521 (lido direto de
  `audit-runtime.ts:498-502`, não coberto por asserção de ausência no
  teste — `toMatchObject` não prova negativa).
