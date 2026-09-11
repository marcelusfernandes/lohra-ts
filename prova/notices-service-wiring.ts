// Issue #411 (M8-9): `AutoResumeScheduler` e `WorkflowLiveEvents` avisam
// pelo `onWarning` que `WorkflowService` já recebe (em produção,
// `noticesSink.warn`), sem crescer `service.ts` (crescimento zero: 1296
// linhas antes e depois — só a construção do `AutoResumeScheduler` em
// `service.ts:~423-426` ganhou `logWarning: this.warn` na mesma linha).
// `WorkflowLiveEvents` já recebia `this.warn` desde `1e2d4bfa5`
// (2026-09-01); `tests/workflow-notices-service-wiring.test.ts` fixa os
// dois: o cold-start rearm de um run já em `MAX_RESUME_ATTEMPTS` (vermelho
// real na base) e o observer de `onLiveEvent` que lança (já verde na base,
// mantido como fixação).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-notices-service-wiring.test.ts"],
} satisfies Declaracao;
