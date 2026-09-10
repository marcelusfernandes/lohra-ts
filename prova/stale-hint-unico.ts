// Declaração de prova da issue #275 (dica de run órfão única entre comando
// e tool): `src/commands/workflow.ts` importa STALE_HINT de
// `src/workflow/service.ts` em vez de manter cópia local divergente;
// `cancel()` reporta o status que o run de fato publicou, não 'cancelled'
// fixo; e o warn de timeout de `shutdown()` restaura a metade perdida na
// #289 ("heartbeat already stopped").
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-command.test.ts", "tests/workflow-shutdown.test.ts"],
} satisfies Declaracao;
