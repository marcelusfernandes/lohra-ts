// Issue #360 (veredito da PR #358, sobre #342): `validateSubObjectFields`
// (`schema.ts`) só conferia NOMES de chave nos sub-objetos agent-shaped
// (`stages[*]`, `body`, `synthesize`, `branches[*]` quando objeto) — os
// valores de `retries`/`timeout`/`max_iterations`/`tool_less` passavam sem
// checagem, e um valor inválido clampava (`retries`) ou virava default
// silencioso (`timeout`) ou `NaN` (`max_iterations`) só em execução.
// `validateKnobValues` (nova, `schema.ts`) aplica a mesma regra de valor —
// e o mesmo texto de erro — do nó a cada sub-objeto, com o campo qualificado
// (`stages[0].retries`, `body.timeout`). `tests/workflow-schema.test.ts`
// prova cada um dos quatro knobs em cada um dos quatro sub-objetos, mais o
// caso node-level `tool_less` (que não tinha checagem de valor nenhuma antes
// desta issue) e um `branches` de string intocado.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-schema.test.ts"],
} satisfies Declaracao;
