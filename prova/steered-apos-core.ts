// Issue #444 (M14): `auditedChildRuntime.steer` (`audit-runtime.ts`, bloco
// `steer`) gravava `leaf.steered` ANTES de `inner.steer` resolver — 11
// eventos para 10 steers de fato enfileirados no teste de teto de S1
// (`MAX_PENDING_STEERS_PER_LEAF`), e um steer num id terminal/desconhecido
// também produzia evento. A ordem foi invertida: o outcome é aguardado
// primeiro, e `record` só roda quando há prova de entrega —
// `outcome !== null && outcome.refused === undefined` (cobre `{queued:
// true}` e a ressurreição idle/terminal `{queued: false}` sem `refused`,
// que é o caminho real do retry de schema do engine; exclui `refused:
// "steer_cap"`, `null` e `undefined`).
//
// `tests/workflow-audit-steered.test.ts` prova o contrato unitário direto no
// decorador: recusa, `null` e `undefined` nunca gravam; `{queued: true}`
// (leaf ocupado) e `{queued: false}` sem `refused` (ressurreição idle/
// terminal, a forma real do retry de schema) gravam. `tests/workflow-steer-
// tool.test.ts` prova end-to-end com `OrchestrationCore` real: exatamente 10
// `leaf.steered` para 11 steers tentados (o 11º recusado não aparece), e um
// steer num sub_id que o ledger conhece mas o core real nunca gerou não
// deixa rastro.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-steered.test.ts", "tests/workflow-steer-tool.test.ts"],
} satisfies Declaracao;
