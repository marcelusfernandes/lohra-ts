// Issue #603: `acked_at` de um aviso reconhecido lia `0` na tool
// `workflow_notices` e na CLI `lohra workflow notices --all --json` —
// `parseNoticeRow` (`src/state/notices-repository.ts`) passava `acked_at`
// por `rowNumber`/`nullableRowNumber`, que zera qualquer valor que não seja
// `Number.isSafeInteger`, e `ack()` grava `Date.now() / 1_000` (fracionário)
// numa coluna `REAL`. Estes testes provam a leitura simétrica a `created_at`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/state-notices-repository.test.ts", "tests/workflow-notices-cross-process.test.ts"],
} satisfies Declaracao;
