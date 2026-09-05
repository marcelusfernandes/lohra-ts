// Declaração de prova da issue #62 (hardening de scripts/ci/**: globs,
// causas de erro, -z, authorised sem Closes, stub em comentário — follow-up
// das PRs #52/#53/#54/#55, ver #36).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/ci-escopo.test.ts",
    "tests/ci-contratos.test.ts",
    "tests/ci-controle-negativo.test.ts",
    "tests/ci-controle-negativo-integracao.test.ts",
    "tests/ci-lib-git.test.ts",
  ],
} satisfies Declaracao;
