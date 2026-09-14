// Declaração de prova da issue #694 (bloqueava a #691): `ehPrDeRelease`
// (`scripts/ci/controle-negativo/lib.ts`) reconhece a PR de release
// (`release/<x.y.z>`, diff só de `package.json`, `package-lock.json` e
// `CHANGELOG.md`) para o `controle-negativo` fazer SKIP antes de resolver
// o slug (`run.ts`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-controle-negativo.test.ts"],
} satisfies Declaracao;
