// Declaração de prova da issue #251 (estimador de tokens do histórico:
// função pura em src/context/token-estimate.ts, calibrada contra usage real
// de dois provedores em tests/fixtures/context/).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/context-estimate.test.ts"],
} satisfies Declaracao;
