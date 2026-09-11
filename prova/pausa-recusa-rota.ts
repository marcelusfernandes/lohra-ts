// Issue #426 (M10-S5, épico #421): uma folha recusada por
// auth_failed/route_fault/model_not_found passa a pausar o run com
// pause_reason: route_fault e uma lição estruturada em pause_payload_json,
// em vez de só degradar. tests/workflow-route-faults.test.ts cobre a
// bifurcação nova (route-faults.ts), a exclusão de faultKinds para kinds
// que pausam o run (emenda 2026-09-12) e a exposição durável de
// pause_reason/lesson; tests/workflow-fault-kinds.test.ts continua cobrindo
// o resto do contrato de fault_kinds que este fix não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-route-faults.test.ts", "tests/workflow-fault-kinds.test.ts"],
} satisfies Declaracao;
