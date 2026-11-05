// Issue #987: `"execution": "<tier>"` em `workflow_tiers.json` — o tier que um
// nó de workflow sem `model` nem `tier`, e um sub-agente de `delegate_task`
// sem `model`, usam por padrão. `workflow-tier-execucao.test.ts` prova o
// leitor fail-closed (`readTiers`), `routingOf`, a identidade de célula
// (`routingIdentity`: sem a chave, a de hoje), o motor por tipo de nó, o
// runner dos filhos (`createChildRunner`, `tiers` lido por spawn) e
// `lohra tiers list`; `workflow-tiers.test.ts` continua cobrindo o contrato
// de tiers que a chave nova não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-tier-execucao.test.ts", "tests/workflow-tiers.test.ts"],
} satisfies Declaracao;
