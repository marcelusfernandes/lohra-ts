// Declaração de prova da issue #91 (scripts/ci/contratos/**): exceção
// `@generated` na regra `arquivo-grande`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-contratos.test.ts"],
} satisfies Declaracao;
