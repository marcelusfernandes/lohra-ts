// Issue #532 (D3, épico #529), parte do orquestrador: job `pack-check` em
// `.github/workflows/ci.yml` (ubuntu-latest × macos-latest × Node 20/22) e a
// saída do `env: PYTHON` do job `checks` — nada mais compila via node-gyp
// desde D10 (#549). O teste pina a forma do job, não o executa.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-pack-check-job.test.ts"],
} satisfies Declaracao;
