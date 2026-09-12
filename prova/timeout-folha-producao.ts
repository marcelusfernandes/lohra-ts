// Issue #521 (M16-S6, épico #490, ADR 0005): `OrchestrationChildRuntime.collect`
// aplica `options.timeoutSeconds` — `Promise.race([this.core.collect(id, true),
// deadline(timeoutSeconds)])`; no deadline devolve `{status: "running", output:
// null}` (a forma que `engine.ts:273` já trata como timeout, chamando `cancel()`
// ELE MESMO — este runtime nunca cancela por conta própria). Zero/negativo/
// ausente = sem prazo. tests/workflow-orchestration-runtime-timeout.test.ts
// (novo) é o vermelho: uma folha presa estoura o timeout do vitest na base
// (o deadline nunca dispara sem este fix); tests/workflow-orchestration-runtime
// .test.ts é a contra-asserção byte-idêntica que este fix não pode quebrar
// (`timeoutSeconds: 5` continua sem efeito nos casos rápidos existentes).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-orchestration-runtime-timeout.test.ts",
    "tests/workflow-orchestration-runtime.test.ts",
  ],
} satisfies Declaracao;
