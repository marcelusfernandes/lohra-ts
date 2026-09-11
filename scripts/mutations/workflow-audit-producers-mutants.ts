// Catálogo de mutantes dos produtores novos do M7 (issue #370): identidade
// causal (`audit-producers.ts`, #365), segmento/pausa/process_crash
// (`audit-producers.ts`, #368), folha e ferramenta (`audit-runtime.ts`,
// #366/#367), cache (`audit-cache.ts`, #368) e o ring do live tail
// (`live-tail.ts`, #369). Estende a fatia `workflow-audit-live` —
// `scripts/mutations/workflow-audit-live.ts` importa este catálogo junto
// com `workflow-audit-live-mutants.ts` (os 32 originais). Mesmo `Mutant`
// comum de `scripts/mutations/types.ts`, mesma mecânica A (git-archive +
// vitest focado) dos 32 originais.
//
// Stub vermelho (issue #370, worktree-segura §7): lança na avaliação do
// módulo para que qualquer teste ou runner que o importe falhe em RUNTIME
// — não em erro de compilação — até o commit seguinte substituir este stub
// pelo catálogo de verdade.
import type { Mutant } from "./types.js";

export const auditProducersMutants: readonly Mutant[] = (() => {
  throw new Error("not implemented: auditProducersMutants");
})();
