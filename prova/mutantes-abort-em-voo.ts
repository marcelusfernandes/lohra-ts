// Issue #519 (M16-S4, épico #490): 7 mutantes novos ancoram o caminho de
// abort em voo já mergeado (S1-S3/S5/S6) no catálogo de mutação —
// `supervision-mutants.ts` (client.ts, child-runner.ts,
// orchestration-runtime.ts), `workflow-audit-producers-mutants.ts`
// (audit-model.ts, audit-runtime.ts) e `context-window.ts` (provider-model.ts,
// token-estimate.ts). Estes três testes provam a contagem e a estrutura de
// cada mutante (schema, `srcGlobs`, `focusFiles`, `before` único, foco
// existente) — a evidência de que cada um MORRE (`killed: true`) é a corrida
// de `npm run mutations:supervision`/`mutations:t17`/`mutations:t23`, colada
// na PR, não um `it()` deste repo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/mutations-slices.test.ts",
    "tests/mutations-t23-catalog.test.ts",
    "tests/mutations-directory-pin.test.ts",
  ],
} satisfies Declaracao;
