// Declaração de prova da issue #191 (harness lê o relatório do vitest de um
// arquivo temporário, não de `/dev/stdout` — Actions/ubuntu falha com
// ENXIO ao abrir `/dev/stdout` para escrita).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-harness.test.ts"],
} satisfies Declaracao;
