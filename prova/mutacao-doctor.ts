// Issue #636: fatia de mutação `doctor` para `src/doctor/**` e
// `src/commands/provider-detectado.ts`. Os testes aqui provam o schema/
// contagem/cobertura de `scripts/mutations/slices.json`; a prova dos 10
// mutantes em si (todos `killed`, `restoreGreen: true`) é `npm run
// mutations:doctor`, colada no test plan da PR (não roda via `npm run
// prova` -- minutos, não segundos).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/mutations-slices.test.ts",
    "tests/mutations-runner-guard.test.ts",
    "tests/mutations-directory-pin.test.ts",
    "tests/mutations-all.test.ts",
  ],
} satisfies Declaracao;
