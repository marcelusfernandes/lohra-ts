// Issue #3: stub-driver colide na porta fixa 11434 sob vitest paralelo —
// os testes agora usam porta efêmera e leem a porta de fato vinculada de
// volta em summary.json.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/parity/stub-driver.test.ts"],
} satisfies Declaracao;
