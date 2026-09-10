// Declaração de prova da issue #239 (veredito de completude e resposta de
// checkpoint iguais através de um resume): `completeness_check` e
// `checkpoint` são células cacheadas (src/workflow/engine.ts:942-994); o
// determinismo entre run e resume é consequência do cache run-scoped do
// WorkflowService/SqliteWorkflowCache, não uma guarda própria de cada tipo.
// Os três testes novos em `tests/workflow-hardening.test.ts` (describe
// "checkpoint/resume verdict parity (#239)") pinam essa consequência pelo
// caminho durável real.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-hardening.test.ts", "tests/workflow-service-durability.test.ts"],
} satisfies Declaracao;
