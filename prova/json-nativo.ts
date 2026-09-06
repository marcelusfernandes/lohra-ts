// Issue #71: substitui pythonJsonDumps* por JSON.stringify (via
// stringifyJsonPreservingNumbers) e remove python-json.ts. Prova cobre o
// stringify novo (indent + rejeição de não-finito) e os consumidores citados
// na issue como golden.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/json-numbers.test.ts",
    "tests/gateway/tool-event-payload.test.ts",
    "tests/transports-provider-modes.test.ts",
    "tests/catalog-pricing.test.ts",
    "tests/cron-store.test.ts",
  ],
} satisfies Declaracao;
