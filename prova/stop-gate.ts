// Issue #43: hook Stop `stop-gate.sh` (tsc + prova do slug da branch). A bancada
// exercita o hook em subprocesso com seams sob LOHRA_BENCH=1; o teste de
// settings prende que o Stop aponta para ele com timeout >= 300s. Esta
// declaração é também o primeiro consumidor real do harness (#42): o próprio
// hook, ao encerrar o turno nesta branch, roda `npm run prova -- stop-gate`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/stop-gate.test.ts", "tests/claude-settings.test.ts"],
} satisfies Declaracao;
