// Declaração de prova da issue #259 (schema_ref/schema inexistente em
// sub-objetos agent-shaped — body/synthesize/stages — passa na carga).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-schema.test.ts"],
} satisfies Declaracao;
