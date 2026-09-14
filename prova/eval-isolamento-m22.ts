// Issue #653 (sub-issue E1 do residual #637, grupo E item 18, veredito da
// PR #618): pino de terminal sem bypass por newline, `LOHRA_PROFILE=""`
// recusado em vez de cair no default, `.eval/` exercitado ponta a ponta e
// prosa de `session.ts`/`docs/eval.md` corrigida.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/eval-cases.test.ts",
    "tests/config.test.ts",
    "tests/eval-session-internals.test.ts",
    "tests/eval-run-output.test.ts",
  ],
} satisfies Declaracao;
