// Declaração de prova da issue #50 (scripts/ci/contratos/**).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-contratos.test.ts"],
} satisfies Declaracao;
