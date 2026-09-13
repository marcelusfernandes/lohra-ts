// Issue #602 (follow-up do veredito da PR #601/#578): o re-collect de uma
// rodada de correção (steer) lia `collected.output` (a prosa do turno) em
// vez de repetir `extractForcedOutput` — como a folha resurrection herda
// `originalConfig` (`forcedTool` incluído, `orchestration/core.ts`'s
// `steer`), a rodada de correção também é forçada, e a validação nunca via
// o argumento real da tool call. A prova cobre o cenário ponta a ponta
// (WorkflowEngine → OrchestrationChildRuntime → OrchestrationCore real →
// createChildRunner): 1ª resposta pela tool com argumento inválido → steer
// → 2ª resposta pela tool válida → nó completa com `forcing_fallbacks: 0` —
// e a suíte de `child-runner.ts` (composeDispatch na interceptação da tool
// sintética; comportamento de `toolCalls` inalterado).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-forced-fallback.test.ts", "tests/orchestration-child-runner.test.ts"],
} satisfies Declaracao;
