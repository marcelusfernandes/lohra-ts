// Declaração de prova da issue #297: forma dos `srcGlobs` documentada em
// `docs/mutation-testing.md` (citando `scripts/github/mutations-matrix.ts:44-62`)
// e sétimo runner (`scripts/mutations/context-window.ts`) na allowlist
// `RUNNERS` de `tests/mutations-runner-guard.test.ts`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-runner-guard.test.ts"],
} satisfies Declaracao;
