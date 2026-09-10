// Issue #313: a tentativa de collectLeaf que morre por TIMEOUT (engine.ts,
// `collected.status === "running"`) gravava o fault e retornava usage() zero
// sem chamar account() — tokens gastos (quando o runtime os reporta) nunca
// entravam em budget.chargeTokens/tokensIn/tokensOut, e um timeout sem usage
// virava zero silencioso em vez de usageUncertain (#232). A extração
// (`timeoutLeafResult`, engine-utils.ts) fecha os dois casos sem crescer
// engine.ts além do import novo. Os três testes em
// "timeout cost enters the budget (#313)" de workflow-parallel-retries.test.ts
// pinam: usage medido debitado (o retry seguinte estoura o orçamento), um
// único débito por leaf id (nunca dobrado) e usage ausente marcado
// usageUncertain, nunca zero silencioso.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-parallel-retries.test.ts"],
} satisfies Declaracao;
