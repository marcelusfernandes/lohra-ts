// Issue #234: workflow_tiers.json inválido vira mapa vazio em silêncio —
// loadTiers passa a distinguir ausente (legítimo) de inválido (erro nomeado),
// run_workflow recusa o launch e `lohra tiers` sai com código 1.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-tiers.test.ts"],
} satisfies Declaracao;
