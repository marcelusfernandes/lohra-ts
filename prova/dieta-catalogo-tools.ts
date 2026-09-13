// Issue #585 (épico #575, P9): as 29 definições de tool
// (`src/tools/builtin-definitions.ts`) eram reenviadas inteiras a cada
// iteração — 43.951 chars de JSON (~18k tokens), 72% delas nas 12 tools de
// workflow, com `run_workflow` sozinha em 8.157 chars de description que
// terminava mandando carregar a skill `workflow-authoring` — que já continha
// o mesmo manual. `tests/builtin-definitions-budget.test.ts` prende o
// orçamento (`JSON.stringify(BUILTIN_DEFINITIONS).length <= 22000`), o
// contrato estrutural (ordem, `name`, schemas de parâmetros sem a chave
// `description`, byte-idênticos ao HEAD anterior) e o padrão prescritivo
// (quando usar / quando não / limite) nas sete tools básicas e em
// `run_workflow`. Os quatro testes de substring que já prendiam descriptions
// específicas (`tests/builtin-definitions-audit-description.test.ts`,
// `tests/workflow-campos-sem-efeito.test.ts`, `tests/workflow-sandbox.test.ts`,
// `tests/workflow-checkpoint-aninhado.test.ts`) continuam intactos — as
// descriptions novas preservam os trechos que eles prendem. O manual movido
// para fora das descriptions (armadilhas, exemplo de spec, semântica de
// pivô/resume, live_tail, o glossário de campos do rollup, os eventos do
// audit trail, `workflow_leaf_read`/`workflow_steer`) ganhou seções próprias
// em `assets/skills/workflow-authoring/SKILL.md`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/builtin-definitions-budget.test.ts",
    "tests/builtin-definitions-audit-description.test.ts",
    "tests/workflow-campos-sem-efeito.test.ts",
    "tests/workflow-sandbox.test.ts",
    "tests/workflow-checkpoint-aninhado.test.ts",
    "tests/tools-core.test.ts",
  ],
} satisfies Declaracao;
