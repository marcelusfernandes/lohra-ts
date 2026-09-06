// Issue #77: follow-ups dos hooks de sessão (prefixos com valor colado,
// seam de argumentos do gh, README). Reaproveita as bancadas da #61.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/protege-main.test.ts", "tests/protege-escrita.test.ts", "tests/stop-gate.test.ts"],
} satisfies Declaracao;
