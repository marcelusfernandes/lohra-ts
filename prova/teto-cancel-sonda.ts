// Issue #568 (milestone "Consertos pós-revisão de M16", épico #561, sub
// S3+S6; vereditos das PRs #528, #543, r2 de #556): (1)
// `OrchestrationChildRuntime.cancel`'s ceiling (`CANCEL_SETTLE_TIMEOUT_MS`,
// orchestration-runtime.ts) agora tem teste com folha que nunca assenta
// (fake timers) provando o `Promise.race` e o `clear()` — a única forma de
// `cancel()` resolver para essa folha é o teto, e o timer nunca vaza quando
// a folha assenta antes dele. (2) `probeSettledAfterCancel`
// (audit-runtime.ts) — a sonda pós-cancel — não engole mais erro nenhum
// (`catch (error)` + `warn` estruturado, fail-closed) e seu filtro
// "running" (sonda tarde demais) tem teste dedicado com um
// `OrchestrationChildRuntime` de verdade. (3) a 3ª forma de `isAbortOf`
// (`error.cause === signal.reason`, conversation/runtime.ts) tem teste
// próprio, e `reason: "cancelled"` está pinado na corrida sonda ×
// assentamento (tests/workflow-abort-in-flight.test.ts). (4) usage de
// turno multi-iteração cancelado pelo signal externo agora soma o usage
// real das chamadas já completas com a estimativa da chamada abortada
// (antes: só a estimativa da última, descartando o real acumulado) —
// `ConversationCancelledError.partialUsage`, único campo que
// `child-runner.ts` lê para o `usage` de uma folha cancelada. (5) prosa
// desatualizada em `token-estimate.ts:207-216` (anthropicPartialUsage
// devolve `null`, não mais `Usage{inputTokens:0}`) e
// `conversation/runtime.ts`'s docblock de `isAbortOf` (a "OTHER shape" do
// fetcher pré-`post()` não existe mais desde #567) corrigidas.
//
// A prova dos mutantes novos (`scripts/mutations/workflow-audit-producers-mutants.ts`)
// é `npm run mutations:t17` (e `mutations:supervision` como gate de
// regressão — contagem inalterada), fora do harness de vitest desta
// declaração — ver Test plan da PR. `tests/mutations-slices.test.ts` prende
// os pinos de contagem.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/orchestration-runtime-collect.test.ts",
    "tests/workflow-abort-in-flight.test.ts",
    "tests/workflow-orchestration-runtime-timeout.test.ts",
    "tests/conversation-runtime.test.ts",
    "tests/mutations-slices.test.ts",
  ],
} satisfies Declaracao;
