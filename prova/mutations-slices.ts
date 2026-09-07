// Declaração de prova da issue #154 (passo 0 do épico #13):
// scripts/mutations/slices.json e o teste que impede fatia órfã.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-slices.test.ts"],
} satisfies Declaracao;
