// Declaração de prova da issue #285 (pina a média por folha do Budget com
// orçamento semeado no resume: o seed do construtor entra no teto
// (tokensSpent) mas nunca nos acumuladores da média — comportamento atual,
// sem mudança de fórmula).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-executor.test.ts"],
} satisfies Declaracao;
