// Catálogo de mutantes de `src/workflow/audit-*` (issue #150, passo 13-S3 do
// épico #13). Stub temporário — teste vermelho antes da migração dos 32
// mutantes de `scripts/parity/workflow-audit-live/run-mutations.ts`.
import type { Mutant } from "./types.js";

export const mutants: readonly Mutant[] = new Proxy([], {
  get(): never {
    throw new Error("not implemented: catálogo de mutação workflow-audit-live (issue #150)");
  },
});
