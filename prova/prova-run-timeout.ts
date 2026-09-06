// Declaração de prova da issue #111 (timeout de `tests/prova-run.test.ts`
// sob carga — ver o cabeçalho do próprio teste).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/prova-run.test.ts"],
} satisfies Declaracao;
