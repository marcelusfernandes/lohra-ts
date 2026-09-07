// Declaração de prova da issue #186: guarda de entry-point única para os
// seis runners de scripts/mutations/ (ehEntryPoint, harness.ts) e o
// catálogo do workflow-executor extraído para workflow-executor-mutants.ts.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-slices.test.ts", "tests/mutations-runner-guard.test.ts"],
} satisfies Declaracao;
