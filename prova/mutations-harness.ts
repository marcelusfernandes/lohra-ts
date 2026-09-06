// Declaração de prova da issue #148 (harness comum e tipo `Mutant` em
// `scripts/mutations/`, passo 0a do épico #13).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-harness.test.ts"],
} satisfies Declaracao;
