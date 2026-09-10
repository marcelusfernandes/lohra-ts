// Declaração de prova da issue #237 (agregação do parallel preserva null
// posicional na forma ["a", null] e conta um grupo todo morto como nó nulo
// com fault nomeado, sem filtrar nulos do array de saída).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-hardening.test.ts"],
} satisfies Declaracao;
