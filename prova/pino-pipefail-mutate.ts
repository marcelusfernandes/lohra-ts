// Issue #325: follow-up do veredito da PR #324 (#323). Pina, no passo
// `mutate` de mutations.yml, o `set -o pipefail` antes do `| tee`, a linha
// exata do `tee` para `.mutation-evidence/`, o `mkdir -p` e o
// `upload-artifact` seguinte com `path:` e `if: always()`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-mutations-workflow.test.ts"],
} satisfies Declaracao;
