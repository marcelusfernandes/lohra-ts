// Issue #476 (milestone 15): três oráculos ausentes de M14 apontados pelos
// vereditos das PRs #472/#474 — o site vivo do override de rota (`launch`,
// sem `store`), `trail.flush()` nos casos negativos de `leaf.steered`
// (`steer_cap`/`null`), e `supervision.ts` na allowlist do guard de
// runners — mais um 4º item, achado da revisão da PR #486: um `route`
// explícito vence uma `suggested_route` DIFERENTE do envelope, tanto em
// `pivots[0]` quanto em `node.rerouted.to`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-route-override-nested.test.ts",
    "tests/workflow-audit-steered.test.ts",
    "tests/mutations-runner-guard.test.ts",
    "tests/workflow-rerouted.test.ts",
  ],
} satisfies Declaracao;
