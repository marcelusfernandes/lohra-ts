// Issue #135 (follow-up de #125/#101, veredito do revisor na PR #133,
// reason 4): `refuse()` em `src/state/workflow-repository.ts` emite
// STALE_FENCE_WRITE num sink cujo default é no-op, e as três construções de
// produção (`sqlite-cache.ts`, `ownership-store.ts`, `commands/workflow.ts`)
// usavam esse default — uma recusa por fence obsoleto desaparecia em
// silêncio. `productionOwnershipStore` agora aceita e repassa um sink de
// warning ao `WorkflowRepository` e ao `LockRepository` que constrói.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-progress-fence.test.ts", "tests/workflow-durable-roots.test.ts"],
} satisfies Declaracao;
