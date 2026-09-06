// Declaração de prova da issue #93 (scripts/ci/contratos/**): a regra
// `arquivo-grande` passa a comparar com a base.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-contratos.test.ts"],
} satisfies Declaracao;
