// Declaração de prova da issue #196 (achados 1-3 do revisor da PR #194):
// diagnóstico de timeout/sinal/exit≠0 em `scripts/mutations/all.ts` e testes
// de `realExecute`/entrypoint que antes não existiam.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-all.test.ts"],
} satisfies Declaracao;
