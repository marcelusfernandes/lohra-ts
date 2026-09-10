// Declaração de prova da issue #250 (resolução da janela efetiva do modelo
// por precedência: override > catalog > table > provider > default).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/providers-context-window.test.ts", "tests/config-context-window.test.ts"],
} satisfies Declaracao;
