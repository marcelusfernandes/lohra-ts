// Issue #149 (passo 0b do épico #13): parte do catálogo de mutantes de
// `mutations:t16`, migrado do runner legado de paridade sem mudar
// id/mechanism/edits — só o caminho e o tipo importado mudam. Separado de
// `workflow-durability.ts` só para caber no limite de 800 linhas por
// arquivo (`arquivo-grande`): este módulo carrega a família de conjuntos
// do guard de escrita possuída (12 mutantes: 3 conjuntos × 4 categorias) e
// os dois mutantes do INSERT combinado cache+custo.
//
// Contract criterion 55 wants two things the shape of this file encodes:
//   * the DIRECT writes (state, cache, node-cost, spend) each prove all three
//     conjuncts of the ownership guard independently. The guard itself is a
//     SINGLE shared primitive (criterion 54 forbids a copy per category), so a
//     conjunct mutant is one edit — what makes the twelve proofs independent is
//     that each one is scored against ONLY that category's planted oracle.
//   * every mutant is a SEMANTIC violation: an edit that leaves valid SQL and
//     valid TypeScript and simply lets a refused write land. A mutant killed by
//     a syntax or arity error proves nothing, so parameter arity is preserved.
import type { Mutant } from "./types.js";

const repository = "src/state/workflow-repository.ts";
const repositoryTests = "tests/state-workflow-repository.test.ts";

// --- the shared guard's three conjuncts -------------------------------------
// Each rewrite consumes its own bound parameter (`? IS NOT NULL`), so arity is
// unchanged and SQLite is happy: the ONLY thing that changes is that one
// conjunct of live ownership stops being checked.
const CONJUNCTS = [
  {
    id: "fence",
    before: "AND f.fence = ?",
    after: "AND ? IS NOT NULL",
    what: "exact current fence",
  },
  {
    id: "holder",
    before: "AND l.holder = ?",
    after: "AND ? IS NOT NULL",
    what: "current lease holder",
  },
  {
    id: "lease-validity",
    before: "AND l.expires_at > ?",
    after: "AND ? IS NOT NULL",
    what: "unexpired lease",
  },
] as const;

const CATEGORIES = [
  { id: "state", test: "guard state" },
  { id: "cache", test: "guard cache" },
  { id: "node-cost", test: "guard node-cost" },
  { id: "spend", test: "guard spend" },
] as const;

export const guardMutants: readonly Mutant[] = CONJUNCTS.flatMap((conjunct) =>
  CATEGORIES.map((category) => ({
    id: `guard-${conjunct.id}-dropped/${category.id}`,
    category: category.id,
    mechanism: `the shared owned-write guard stops checking the ${conjunct.what}; scored against the ${category.id} planted phases`,
    focus: { file: repositoryTests, test: category.test },
    edits: [{ file: repository, before: conjunct.before, after: conjunct.after }],
  })),
);

export const combinedMutants: readonly Mutant[] = [
  {
    id: "combined-cell-guard-removed",
    category: "combined",
    mechanism: "the combined cache+cost cell INSERT drops the ownership guard entirely",
    focus: { file: repositoryTests, test: "guard combined" },
    edits: [
      {
        file: repository,
        before:
          "        .prepare(`${cellSql}${guard.suffix}`)\n        .run(hash, runId, nodeId, outputJson, status, ownership.now, ...guard.params);",
        after:
          "        .prepare(cellSql)\n        .run(hash, runId, nodeId, outputJson, status, ownership.now);",
      },
    ],
  },
  {
    id: "combined-cost-escapes-refusal",
    category: "combined",
    mechanism:
      "the cost INSERT runs even when the guarded cell was refused (no longer 'priced or absent')",
    focus: { file: repositoryTests, test: "guard combined" },
    edits: [
      {
        file: repository,
        before: "      if (cell.changes === 0) return false;\n      if (cost !== null) {",
        after: "      const refusedCell = cell.changes === 0;\n      if (cost !== null) {",
      },
      {
        file: repository,
        before:
          "      }\n      return true;\n    });\n    try {\n      // A refused cell is a refused WRITE",
        after:
          "      }\n      return !refusedCell;\n    });\n    try {\n      // A refused cell is a refused WRITE",
      },
    ],
  },
];
