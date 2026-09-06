// Issue #70: extração da fidelidade numérica de python-json.ts para
// json-numbers.ts. Prova cobre o módulo novo e todo consumidor que trocou
// de import.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/json-numbers.test.ts",
    "tests/python-json.test.ts",
    "tests/catalog-pricing.test.ts",
    "tests/transports-provider-clients.test.ts",
    "tests/transports-provider-modes.test.ts",
    "tests/workflow-refs.test.ts",
    "tests/gateway/tool-event-payload.test.ts",
  ],
} satisfies Declaracao;
