// Issue #450 (M14, non_blocking a-1/a-2 do veredito da PR #443): `steer`
// declarava `void` mas `OrchestrationChildRuntime`/`AuditedChildRuntime`
// devolviam o outcome real de `core.steer` por baixo do tipo, via `as
// unknown as undefined`, e `steer-tool.ts` recuperava com `typeof ===
// "object"`. `ChildRuntime` ganha `steerOutcome?` — membro NOVO e opcional
// (mesmo padrão de `causalSnapshot?`, `runtime.ts:100`), nunca um
// alargamento de `steer` (confirmado: uma união contendo `void` não
// satisfaz a leniência de retorno void do TypeScript — é exatamente o que
// travou a tentativa original, #424 2ª emenda).
//
// `OrchestrationChildRuntime.steerOutcome` devolve `core.steer(...)`
// tipado; `steer` volta a ser `void` de verdade. `AuditedChildRuntime`
// ganha o mesmo par — `steerOutcome?` só existe na instância quando
// `inner.steerOutcome` existe (mesmo padrão condicional de `causalSnapshot`/
// `installLeafSandbox` já usado neste arquivo); quando ausente, `steer`
// delega direto a `inner.steer` sem gravar `leaf.steered` (mesma regra do
// #444 para um outcome não comprovado). `steer-tool.ts` usa
// `runtime.steerOutcome` quando presente; ausente é um erro nomeado
// («runtime sem steerOutcome»), nunca um `queued: true` inventado.
//
// `tests/workflow-steer-tool.test.ts` prova as duas pontas end-to-end (um
// runtime com `steerOutcome` entrega `queued` real; um runtime sem
// `steerOutcome` nunca reporta `queued: true`) e o oráculo de tipo (`satisfies
// ChildRuntime`, `steerOutcome` sem alargar `steer`). `tests/workflow-audit-
// steered.test.ts` e `tests/workflow-audit-leaf.test.ts` (emenda da issue,
// 2026-09-13) só tiveram os mocks convertidos — nenhuma asserção mudou.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-steer-tool.test.ts",
    "tests/workflow-audit-steered.test.ts",
    "tests/workflow-audit-leaf.test.ts",
  ],
} satisfies Declaracao;
