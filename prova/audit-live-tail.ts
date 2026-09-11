// Issue #369: `WorkflowLiveTail` (ring por eventos E bytes, cursor
// monotônico, `dropped` exposto, `isKnown` para distinguir run em processo
// de leitura só durável) consumido por `workflow_status.live_tail` via
// `WorkflowTool`; `chat.ts`/`dashboard.ts` ligam `onLiveEvent` a uma
// instância própria e sobrepõem só o handler de `workflow_status`
// (`composeSessionTools`/`session-tools.ts` fica fora dos Files da issue);
// `lohra workflow watch --events` segue o ledger durável (`AuditRepository`)
// por `after_seq`, cross-process-honesto. tests/workflow-live-tail.test.ts
// cobre o ring, o consumo em `WorkflowTool` e o wiring real (`runChat`/
// `runDashboard` com stub de provider); tests/workflow-watch-events.test.ts
// cobre `--events`; tests/workflow-command.test.ts (intacto) prova que o
// caminho sem `--events` continua byte-idêntico.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-live-tail.test.ts",
    "tests/workflow-watch-events.test.ts",
    "tests/workflow-command.test.ts",
  ],
} satisfies Declaracao;
