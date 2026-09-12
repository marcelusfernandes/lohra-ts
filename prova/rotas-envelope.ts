// Issue #459 (M11-S1, épico #458): `workflow_routes.json` fail-closed
// (molde `readTiers`) e `suggested_route` preenchido a partir do envelope
// do operador no terminal do service — nunca uma rota já tentada neste run.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-routes.test.ts", "tests/workflow-route-faults.test.ts"],
} satisfies Declaracao;
