// Issue #514 (follow-up de #499, PR #504, veredito non_blocking 1):
// `mutations-matrix.ts` só selecionava fatia por `srcGlobs` ou por
// `scripts/mutations/**`; um diff só de `tests/**` que edita um `focusFiles`
// de alguma fatia (ex.: `tests/workflow-durable-roots.test.ts`, foco de
// `workflow-durability`) devolvia `count: 0` e o required check `mutations`
// passava por vacuidade. Agora `focusFiles` também seleciona a fatia
// (`reason: "focus"`); arquivo de teste fora de qualquer `focusFiles`
// continua `count: 0`/`reason: "paths"`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-mutations-workflow.test.ts", "tests/mutations-slices.test.ts"],
} satisfies Declaracao;
