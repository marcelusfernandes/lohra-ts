// Declaração de prova da issue #213 (PACK_CHAT_MISMATCH por comparar JSON
// com espaços contra a serialização compacta do runtime — expectedResult em
// scripts/pack-check.ts:135 vs. stringifyJsonPreservingNumbers).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/pack-check.test.ts"],
} satisfies Declaracao;
