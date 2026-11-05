// Issue #979 (S2 do épico #976): o nó `switch` — escolhe UM caso pelo valor de
// um campo do estado (`value`, um `${ref}`), com `cases` (2 a 16 chaves, cada
// uma `null` ou agent-shaped com `prompt`) e `otherwise`. Saída
// `{case, matched, output}`; roda exatamente o leaf do caso escolhido.
//
// - `tests/workflow-switch.test.ts`: o motor — valor escalar escolhe o caso,
//   `otherwise` com `matched:false`, fault com o valor sem `otherwise`, raiz
//   null dá `upstream null`, um leaf só com role `switch.case` e `item_index`,
//   hash de célula pinado, resume com o mesmo valor e com um valor mudado.
// - `tests/workflow-switch-schema.test.ts`: a validação (`value`, `cases`,
//   `otherwise`, knob de roteamento só no nó).
// - `tests/workflow-cache-preview-flow.test.ts`: o ledger (só o caso
//   escolhido), o resume (`cache.replayed` / `cache.missed{identity_changed}`)
//   e o preview (`replay`, `recompute`, `no_leaves` para um caso `null`).
// - `tests/workflow-audit-allow-list.test.ts`: oráculos positivo e negativo da
//   role `switch.case`.
// - `tests/builtin-definitions-budget.test.ts`: o catálogo ≤ 23.000 chars, com
//   a lista de tipos derivada de `NODE_TYPES` e o hash dos parâmetros de
//   `run_workflow` mudado de propósito.
// - `tests/skill-workflow-flow-control.test.ts`: o anti-drift da skill
//   companheira e o ponteiro no `SKILL.md` principal (≤ 800 linhas).
// - `tests/workflow-schema.test.ts`: o registro fechado de tipos (+ switch).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-switch.test.ts",
    "tests/workflow-switch-schema.test.ts",
    "tests/workflow-cache-preview-flow.test.ts",
    "tests/workflow-audit-allow-list.test.ts",
    "tests/builtin-definitions-budget.test.ts",
    "tests/skill-workflow-flow-control.test.ts",
    "tests/workflow-schema.test.ts",
  ],
} satisfies Declaracao;
