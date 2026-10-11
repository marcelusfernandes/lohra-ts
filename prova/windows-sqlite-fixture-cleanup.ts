import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-service-durability.test.ts",
    "tests/workflow-service-durability-cleanup.test.ts",
  ],
} satisfies Declaracao;
