// Issue #132: prende a forma de lançamento do candidato do gateway em
// `scripts/parity/gateway/launch-candidate.ts` (`--import tsx` em vez do
// wrapper `tsx/dist/cli.mjs`, que fazia um handshake IPC de sinal e podia
// sair 130 sob carga — diagnóstico da PR #131). `launch-candidate-argv.test.ts`
// prende o argv do spawn (unitário, mocka child_process); `launch-candidate.test.ts`
// é o teste de subprocesso real que a mudança precisa continuar passando.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/gateway/launch-candidate-argv.test.ts", "tests/gateway/launch-candidate.test.ts"],
} satisfies Declaracao;
