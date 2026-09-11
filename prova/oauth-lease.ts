// Declaração de prova da issue #354 (lease de arquivo sobre a renovação do
// token OAuth, escrita fora do try do POST, fatia de mutação para
// src/auth/**).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/auth-core.test.ts"],
} satisfies Declaracao;
