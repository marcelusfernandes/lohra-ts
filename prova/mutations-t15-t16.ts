// Declaração de prova da issue #149 (migração de mutations:t15/t16 para
// scripts/mutations/, passo 0b do épico #13).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/orchestration-child-runner-mutation-catalog.test.ts",
    "tests/workflow-progress-cobertura.test.ts",
    "tests/workflow-shutdown.test.ts",
    "tests/workflow-service-durability.test.ts",
    "tests/workflow-durable-roots.test.ts",
    "tests/mutations-harness.test.ts",
    "tests/mutations-fixtures-workflow-executor.test.ts",
  ],
} satisfies Declaracao;
