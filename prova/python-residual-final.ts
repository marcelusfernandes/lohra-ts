// Issue #94: última rodada de nomes e textos residuais com Python fora do
// Files da #75 — pythonTruthy/pythonInt de src/media/coercion.ts (consumidos
// em handlers.ts), o remédio "python3 -m json.tool" de src/doctor/checks.ts,
// o comentário de src/serialization/json-numbers.ts que ainda cita
// python-json.ts, o título de tests/json-presence.test.ts, e o pythonInt
// local de src/orchestration/fanout-config.ts e src/cron/schedule.ts.
// src/onboarding/wizard.ts e src/cli.ts:394-395 ficam como estão (decisão do
// orquestrador, 2026-09-06): pythonSupported/pythonVersion é semântica do
// envelope do doctor, não mimetismo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/media-handlers.test.ts",
    "tests/media-normalization.test.ts",
    "tests/json-presence.test.ts",
    "tests/cli-doctor.test.ts",
    "tests/doctor-checks-remedy.test.ts",
    "tests/orchestration-fanout-config.test.ts",
    "tests/cron-schedule.test.ts",
  ],
} satisfies Declaracao;
