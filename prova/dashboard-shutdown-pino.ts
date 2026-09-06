// Issue #129 — follow-up ao veredito do revisor na PR #127 (reasons 2-4):
// (1) tests/workflow-durable-chat.test.ts ganha o gate determinístico do
// leaf (a resposta do turno 2 só sai depois que o leaf de fato disparou o
// próprio request, nunca por um setTimeout fixo); (2) o mesmo reforço,
// via runDashboard real (WS + stub SSE), prende dashboard.ts:301 — um
// segundo nó (`depends_on`) é o que torna a mutação manual observável
// (mutação em um único leaf não reprova: ver o docstring de
// twoNodeWorkflowSpec() em workflow-durable-dashboard.test.ts); (3) o
// teto de shutdown() (SHUTDOWN_SETTLE_TIMEOUT_MS) ganha entrada em
// mutants-orchestration.ts, pinada por um teste embutido em
// workflow-shutdown.test.ts (molde de #112's
// orchestration-child-runner-mutation-catalog.test.ts) — não há arquivo
// de catálogo próprio declarado aqui porque a issue só nomeia os três
// arquivos de teste já existentes.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-durable-dashboard.test.ts",
    "tests/workflow-durable-chat.test.ts",
    "tests/workflow-shutdown.test.ts",
  ],
} satisfies Declaracao;
