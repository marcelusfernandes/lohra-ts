// Issue #987: `"execution": "<tier>"` em `workflow_tiers.json` — o tier que um
// nó de workflow sem `model` nem `tier`, e um sub-agente de `delegate_task`
// sem `model`, usam por padrão. `workflow-tier-execucao.test.ts` prova
// `routingOf`, a identidade de célula (`routingIdentity`: sem a chave, a de
// hoje), o motor por tipo de nó e o runner dos filhos (`createChildRunner`,
// `tiers` lido por spawn, fiado por `buildOrchestrationCore`);
// `workflow-tiers.test.ts` prova o leitor fail-closed (`readTiers`), o
// `executionTier` e `lohra tiers list`, e segue cobrindo o contrato de tiers
// que a chave nova não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-tier-execucao.test.ts", "tests/workflow-tiers.test.ts"],
} satisfies Declaracao;
