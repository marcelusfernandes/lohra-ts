// Issue #400 (M8-4): tabela `operator_notices` + `NoticesRepository`
// (`src/state/notices-repository.ts`), irmão de `AuditRepository`
// (`src/state/audit-repository.ts`). `tests/state-notices-repository.test.ts`
// cobre append sob fence (dono grava, fence velho recusado e contado, run
// sem ownership recusado, global sem ownership grava), kind fora do
// vocabulário (recusa nomeada, nunca grava, nunca lança), truncamento de
// mensagem em 2 KiB numa fronteira de UTF-8, ack idempotente, list()
// default vs include_acked, e retenção LRU por escopo (reconhecidos caem
// primeiro).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/state-notices-repository.test.ts"],
} satisfies Declaracao;
