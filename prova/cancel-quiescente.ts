// Declaração de prova da issue #233 (cancel() responde 'cancelled' com
// folhas ainda rodando): engine.cancel() agora sinaliza activeLeaves como
// noteQuotaExhausted; service.cancel() aguarda a quiescência com o teto de
// shutdown() e só devolve 'cancelled' com zero folhas em voo — estoura o
// teto, devolve 'cancelling' com leaves_in_flight e um aviso.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-shutdown.test.ts", "tests/workflow-service-durability.test.ts"],
} satisfies Declaracao;
