// Declaração de prova da issue #114 (SKIP explícito para diff só de
// tests/**+prova/** — base+overlay ≡ head).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-controle-negativo.test.ts", "tests/ci-controle-negativo-integracao.test.ts"],
} satisfies Declaracao;
