// Issue #161: matriz de causas de check-ancestry.ts contra repositório git
// temporário (NOT_ANCESTOR, PENDING com/sem --pending-ok, JSON malformado,
// lista só-pending com SHA real, SHALLOW_CLONE fabricado, --provenance sem
// valor) — complementa tests/provenance-check.test.ts (declarada em
// prova/provenance-flags.ts), que já cobre ancestral ok, SHA_UNKNOWN e
// PROVENANCE_EMPTY com placeholder.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/provenance-ancestry.test.ts"],
} satisfies Declaracao;
