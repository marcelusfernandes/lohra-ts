// Declaração de prova da issue #345 (markdown de skill em
// `assets/skills/**` conta como classe docs no `controle-negativo`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-controle-negativo.test.ts"],
} satisfies Declaracao;
