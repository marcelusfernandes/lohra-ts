// Issue #214: `tests/prova-declaracoes.test.ts` varre `prova/*.ts` e
// reprova, citando slug e caminho, se alguma declaração apontar para um
// arquivo de teste inexistente, fora de `tests/` ou sem sufixo `.test.ts`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/prova-declaracoes.test.ts"],
} satisfies Declaracao;
