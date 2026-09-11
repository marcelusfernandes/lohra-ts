// Issue #367: `auditedChildRuntime.installLeafSandbox` embrulha a
// instalação do sandbox de uma folha para publicar `tool.started`/
// `tool.completed`, com a identidade causal (`sub_id`, `segment_id`) que
// `leaf.*` (#366) já publica. tests/workflow-audit-tool.test.ts prova o
// contrato novo (sucesso via onToolSettled, recusa síncrona do sandbox →
// sandbox_denied, tool_name_state known/unknown, sanitização, fence);
// tests/workflow-orchestration-runtime.test.ts prova o threading de `subId`
// até `wrapDispatch` (core.ts/child-runner.ts/orchestration-runtime.ts) sem
// quebrar o fake que ainda chama `wrapDispatch(base)` sem `subId`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-tool.test.ts", "tests/workflow-orchestration-runtime.test.ts"],
} satisfies Declaracao;
