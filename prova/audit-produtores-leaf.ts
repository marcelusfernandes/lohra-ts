// Issue #366: `auditedChildRuntime` — decorador do `ChildRuntime` que
// publica `leaf.started|completed|failed` com a identidade causal que o
// engine já monta em cada spawn. tests/workflow-audit-leaf.test.ts prova o
// contrato novo (started+terminal por folha, terminal único após
// steer/collect duplo, timeout, cancel, aninhado herda segment_id,
// sanitização, volume, fence, shutdown com flush); workflow-audit-live
// continua cobrindo o resto do contrato de audit/live que a sequência ganhar
// leaf.* não pode quebrar (asserção ajustada em :1123-1128).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-leaf.test.ts", "tests/workflow-audit-live.test.ts"],
} satisfies Declaracao;
