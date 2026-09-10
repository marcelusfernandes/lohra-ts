// Issue #240: a chave da célula do cache (`src/workflow/cache.ts`,
// `src/workflow/engine.ts:357-359`, `:379`) é `runId` + `contentHash(spec.name,
// meta.version, ...parts)`; a política do operador vive fora dela por
// construção (`src/workflow/service.ts:586,675,822`) — só o tier map entra,
// resolvido via `routingIdentity`. `tests/workflow-hardening.test.ts` pina os
// dois lados: mudar a política entre run e resume não invalida a célula;
// mudar o tier map do MESMO nome de tier invalida (comportamento correto).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-hardening.test.ts"],
} satisfies Declaracao;
