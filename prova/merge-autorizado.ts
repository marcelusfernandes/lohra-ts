// Issue #944: válvula LOHRA_MERGE_AUTORIZADO=<n> do protege-main — merge de uma
// PR nomeada, autorizada pelo owner, com check informativo vermelho.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/protege-main.test.ts"],
} satisfies Declaracao;
