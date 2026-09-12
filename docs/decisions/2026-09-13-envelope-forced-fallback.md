# `forced_fallback` sai do envelope de `collect_session`

- **Data:** 2026-09-13
- **Origem:** issue #419 (M8-12, épico #396); OK explícito do owner
  registrado no comentário de 2026-09-13 na issue, para a opção (a).

## Contexto

O veredito da PR #417 (issue #403) já tinha estabelecido que o runtime não
tem fallback de modelo: `pair[0].fallbackModels[0]` (`client-pool.ts:149`) é
só o DEFAULT do provedor no caminho feliz, nada percorre
`fallbackModels[1..]`, e um modelo inexistente vira `model_not_found`
(`transports/error-kinds.ts`) sem retry. A rodada 2 de #403 removeu
`ChildResult.forcedFallback` e os três repasses sempre-`false` na camada de
workflow (`engine.ts:332`, `orchestration-runtime.ts:223`,
`audit-runtime.ts:251`), mas deixou de propósito `CollectResult.forcedFallback:
boolean` (`src/orchestration/core.ts`) e a chave `forced_fallback` no
envelope de `collect_session` (`src/orchestration/tools.ts`) — a nota
`2026-09-12-envelope-delegate-aditivo.md` já registrava que remover essa
chave "continua fora de escopo — issue #419, que exige ADR" (ADR 0003 fixa a
ordem de inserção do wire format; remover ou reordenar uma chave existente é
gatilho de revisão sob a ADR, não uma mudança aditiva como #232).

`delegate_task` nunca teve `forced_fallback` entre as 8 chaves que #429
acrescentou por tarefa (`sub_id, status, summary, error_kind, tokens_in,
tokens_out, provider, model`) — só `collect_session` carregava a chave morta.

## Decisão

- `CollectResult.forcedFallback` (`src/orchestration/core.ts`) sai da
  interface. Os dois produtores em `src/orchestration/child-runner.ts`
  (o caminho normal de `zeroResult` e o branch de erro de resolução de
  provedor/modelo) param de escrever o campo — nenhum dos dois nunca
  computou um valor real; era sempre `false`.
- `collectEnvelope` (`src/orchestration/tools.ts`) para de escrever
  `forced_fallback` — o envelope de sucesso de `collect_session` cai de 13
  para 12 chaves, na mesma ordem relativa das 12 que sobram. O envelope
  `"pending"` (`wait:false`, ainda não medido contra o oráculo) perde a
  mesma chave, pela mesma razão.
- `delegate_task` não muda: nunca teve a chave, então as 8 chaves de #429
  ficam como estão.
- Nenhuma outra semântica muda — `forcing_fallbacks` (contador do fallback
  de schema forçado do próprio motor, `engine-utils.ts`) é um conceito
  diferente e não é tocado por esta decisão.

### Por que ADR e não aditivo

ADR 0003 (`docs/adr/0003-native-wire-format.md`) trata remover ou reordenar
uma chave existente do wire format como gatilho de revisão sob a própria
ADR — ao contrário de acrescentar uma chave nova no fim (#232, #429), que é
aditivo e não precisa desse gate. O owner deu o OK explícito na issue antes
desta implementação, cumprindo esse gate.

## Doutrina para autores de spec

- Um chamador de `collect_session` que lia `forced_fallback` como sinal de
  "o runtime trocou de modelo por conta própria" nunca tinha um sinal real
  ali — o campo era sempre `false`, sem produtor. Não há substituto: essa
  informação não existe hoje porque o runtime não implementa fallback de
  modelo (ver #403). `forcing_fallbacks` (schema forçado) continua sendo o
  único contador relacionado, e mede algo diferente.

## Evidência

- `tests/orchestration-tools.test.ts`: o envelope de sucesso de
  `collect_session` repinado para 12 chaves, sem `forced_fallback`,
  verificado por `Object.keys` (ordem exata) e pelo byte-exato do envelope
  inteiro.
- Fixtures de `CollectResult` em `tests/orchestration-*.test.ts` e
  `tests/workflow-*.test.ts` (a lista completa em `## Files` da issue #419)
  perdem só a linha `forcedFallback: false` — nenhuma delas testava o
  campo por si, só o preenchiam por exigência do tipo.
