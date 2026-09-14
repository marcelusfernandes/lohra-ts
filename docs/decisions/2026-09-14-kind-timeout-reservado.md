# Kind `timeout` reservado, sem produtor hoje

- **Data:** 2026-09-14
- **Origem:** veredito da PR #635 (issue #608, test plan «`timeout` não é
  produzível hoje»); issue #652 (sub-issue C2 de #637, grupo C item 15d).

## Contexto

`src/transports/error-kinds.ts:19` reserva `"timeout"` no vocabulário
fechado (`ERROR_KINDS`, consumido por `NOTICE_KINDS` em
`src/state/notices-repository.ts:24`). `classifyProviderError`
(`src/transports/errors.ts:248-268`) — a função que mapeia uma falha crua de
provedor para um `NoticeKind` — nunca devolve `"timeout"`: `ETIMEDOUT` está
em `networkFaultCodes` (`errors.ts:21`), que classifica para
`"route_fault"`. `buildTurnNotice` (`src/context/notices-overlay.ts:136-144`,
issue #608) herda essa classificação para o aviso de turno morto. Medido em
`tests/transport-error-kinds.test.ts`: nenhum teste do repositório produz um
`ConversationError`/erro de provedor classificado como `"timeout"` hoje.

`route_fault` — o kind que `ETIMEDOUT` de fato produz — tem consumidor
próprio: `src/workflow/route-faults.ts` pausa o run com uma lição
estruturada (`docs/decisions/2026-09-12-pausa-por-recusa-de-rota.md`) e o
kind está ancorado em `scripts/mutations/supervision-mutants.ts` e
`tests/transport-error-kinds.test.ts`. Mudar `classifyProviderError` para
produzir `"timeout"` em vez de `"route_fault"` para `ETIMEDOUT` não é uma
mudança local — quebra esse consumidor e os mutantes que o pinam.

## Decisão

- `"timeout"` continua no vocabulário fechado de `NoticeKind`
  (`ERROR_KINDS`/`NOTICE_KINDS`), sem produtor hoje. Um consumidor
  (`docs/operator-notices.md`, uma tool, um teste de contrato) que espera
  ver `"timeout"` em algum aviso está enganado — nenhum caminho de código
  emite esse kind neste runtime, a partir desta nota.
- `classifyProviderError` e `src/transports/error-kinds.ts` **não mudam**
  por causa desta decisão — permanecem byte-idênticos ao HEAD anterior a
  esta PR.
- Um produtor legítimo futuro de `"timeout"` é um **deadline do próprio
  runtime** (um budget de tempo que este processo impõe e estoura,
  independente de qualquer resposta do provedor) — não um erro de rede do
  provedor. Hoje não existe um `ConversationError` desse tipo; quando um for
  desenhado, ele é quem produz `"timeout"`, e a issue que o desenhar decide
  se `"route_fault"` continua cobrindo `ETIMEDOUT` de provedor em paralelo.

### Por que não produzir `timeout` em `buildTurnNotice` para `ETIMEDOUT`

Alternativa cogitada e rejeitada: fazer `buildTurnNotice` (ou
`classifyProviderError`) mapear `ETIMEDOUT` para `"timeout"` em vez de
`"route_fault"`. Rejeitada porque criaria **dois kinds para a mesma causa**
— o aviso ao operador diria `timeout`, mas a lição de rota que pausa o run
(`route-faults.ts`) continuaria dizendo `route_fault` para o mesmo
`ETIMEDOUT` — sem um motivo de produto para a divergência, só uma
inconsistência nova entre dois canais que hoje concordam.

## Doutrina para autores de spec

Um `NoticeKind` no vocabulário fechado não é uma promessa de que algum
caminho de código o produz — `"timeout"` é o contra-exemplo vivo. Antes de
depender de um kind específico aparecer num aviso, confirmar contra
`classifyProviderError`/os produtores de `NOTICE_KINDS` (`append` calls em
`src/**`), não só contra o vocabulário.

## Evidência

`tests/transport-error-kinds.test.ts` — vocabulário fechado, sem mutação;
`grep -rn '"timeout"' src/transports/errors.ts` não encontra nenhum
`return` que o produza, só a entrada do vocabulário em
`error-kinds.ts:19`.
