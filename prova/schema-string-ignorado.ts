// Declaração de prova da issue #231 (schema em forma de texto na engine).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-schema.test.ts", "tests/workflow-nodes-tool.test.ts"],
} satisfies Declaracao;
