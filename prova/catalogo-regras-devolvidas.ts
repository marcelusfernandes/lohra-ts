// Issue #605 (épico #575, follow-up dos vereditos r1/r2 da PR #598): regras
// de comportamento que a dieta do catálogo (#585) deixou sem destino voltam
// ao catálogo/skill, e `filesystem.ts` para de manter uma cópia divergente
// de description.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/builtin-definitions-budget.test.ts",
    "tests/tools-terminal-description.test.ts",
    "tests/tools-filesystem-description.test.ts",
  ],
} satisfies Declaracao;
