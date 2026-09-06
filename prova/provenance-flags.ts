// Issue #159: provenance:check ganha --json (`{checked, ok, failures,
// skipped}`), --pending-ok e causas nomeadas (SHA_UNKNOWN, NOT_ANCESTOR,
// SHALLOW_CLONE, PENDING) — o classificador é testado com `git` injetado.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/provenance-check.test.ts"],
} satisfies Declaracao;
