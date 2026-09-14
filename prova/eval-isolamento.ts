// Issue #607 (follow-up dos vereditos da PR #595, épico #575): isolamento
// do terminal in-process, profile próprio no modo provider, parser sem
// oráculo vazio e correção do chdir corrompido em runInProcess.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/eval-runner.test.ts",
    "tests/eval-cases.test.ts",
    "tests/eval-session-internals.test.ts",
    "tests/eval-run-output.test.ts",
  ],
} satisfies Declaracao;
