// Issue #696: `lohra doctor`/`lohra init` mostravam um check `python` fixo
// (`python 3.12.10`) sem o runtime jamais chamar ou embutir Python. Removido
// de `checks.ts`, `model.ts`, `snapshot.ts`, `cli.ts` e `wizard.ts`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/cli-doctor.test.ts", "tests/onboarding.test.ts"],
} satisfies Declaracao;
