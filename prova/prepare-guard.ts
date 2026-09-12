// Issue #544 (D9 do épico #529, follow-up de #530/PR #541): guard por
// variável de ambiente em `scripts/prepare.mjs` para `npm pack` (chamado por
// `tests/package-manifest.test.ts` e `scripts/pack-check.ts`) parar de
// instalar hooks de git no checkout real.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/prepare-guard.test.ts",
    "tests/postinstall.test.ts",
    "tests/package-manifest.test.ts",
    "tests/pack-check.test.ts",
  ],
} satisfies Declaracao;
