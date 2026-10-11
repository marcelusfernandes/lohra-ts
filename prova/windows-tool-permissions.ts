import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/tools-local.test.ts",
    "tests/tools-security-lifecycle.test.ts",
    "tests/cron-store.test.ts",
  ],
} satisfies Declaracao;
