// Issue #97: residuais finais da fase 2 do épico #16 — pythonInt de
// src/orchestration/limits.ts vira parseIntStrict (fanout-config.ts perde o
// alias e o comentário errado sobre #73); pythonFloatStr de src/cron/format.ts
// vira formatFloatForCron; o texto visível "invalid JSON (JSONDecodeError)"
// de src/doctor/checks.ts, src/catalog/catalog.ts e src/doctor/snapshot.ts
// vira "invalid JSON", sem citar a exceção do Python; isPythonInt/
// isFinitePythonFloat/isPythonFloat de src/cli/arg-validation.ts e
// parsePythonInt/parsePythonFloat de src/commands/cron.ts viram
// isIntegerToken/isFiniteFloatToken/isFloatToken e
// parseIntegerFlag/parseFloatFlag (acréscimo ao Files em 2026-09-06, segunda
// pré-checagem do implementador).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/orchestration-limits.test.ts",
    "tests/orchestration-fanout-config.test.ts",
    "tests/cron-schedule.test.ts",
    "tests/doctor-checks-remedy.test.ts",
    "tests/cli-arg-validation.test.ts",
    "tests/commands-cron.test.ts",
  ],
} satisfies Declaracao;
