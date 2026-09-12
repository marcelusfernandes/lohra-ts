// Issue #460 (M11-S2, épico #458): resume sem `route` aplica a rota sugerida
// pelo envelope do operador (canal `route_envelope`), sujeito ao mesmo teto
// de 3 pivôs que `route` explícito (canal `operator`) já usa (#427); grava
// `node.rerouted` por nó reescrito.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-rerouted.test.ts",
    "tests/workflow-route-override.test.ts",
    "tests/workflow-audit-allow-list.test.ts",
  ],
} satisfies Declaracao;
