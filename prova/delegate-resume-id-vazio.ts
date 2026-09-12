// Issue #500 (follow-up de #419, PR #496): no dogfooding do Codex, o modelo
// enviava `delegate_task` repetidamente com `resume_id: ""` e
// `max_iterations` preenchido por default. `tools.ts:162`'s
// `args.resume_id !== undefined` e `validation.ts:78`'s
// `validateResumeOverrides` tratavam a string vazia como pedido de resume, e
// a chamada era recusada com "cannot change max_iterations when resuming a
// subagent" — a ferramenta nunca concluía nesse harness.
//
// Solução (a): `resume_id` vazio ou só-espaços vale ausência, normalizado
// UMA VEZ (`normalizeResumeId`, `validation.ts`) antes de qualquer guard de
// resume em `delegateTaskTool` (`tools.ts`).
//
// `tests/orchestration-tools.test.ts` prova as duas pontas: `resume_id: ""`
// (e `"   "`) com `max_iterations` roda o lote normal (envelope de 8
// chaves); `resume_id` não vazio + `max_iterations` continua recusado
// (não-regressão).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/orchestration-tools.test.ts", "tests/orchestration-validation.test.ts"],
} satisfies Declaracao;
