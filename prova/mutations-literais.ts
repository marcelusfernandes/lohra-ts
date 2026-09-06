// Declaração de prova da issue #178 (pino de diretório: `scripts/mutations/**`
// sem literais de paridade/oráculo nem shebang morto, follow-up da rodada 2
// da PR #174).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-directory-pin.test.ts"],
} satisfies Declaracao;
