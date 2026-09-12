// Declaração de prova da issue #532 (pack:check portátil em Linux/macOS,
// Node 20/22, e falha explícita quando a instalação do consumidor
// precisaria compilar nativo em vez de usar prebuild).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/pack-check.test.ts"],
} satisfies Declaracao;
