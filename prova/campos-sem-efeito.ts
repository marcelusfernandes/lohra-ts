// Issue #238: quatro campos de NODE_SPECS sem consumidor
// (`min_success_ratio`, `loop_until_dry.budget`, `label`, `phase`) e
// sub-objetos (`stages[*]`, `body`, `synthesize`, `branches[*]`) sem
// varredura de chave desconhecida. `tests/workflow-campos-sem-efeito.test.ts`
// cobre os quatro campos, a validação de sub-objeto, o não-objeto em
// `stages[*]` (nota do revisor da PR #262) e o teste estrutural anti-drift;
// `tests/workflow-schema.test.ts` continua cobrindo o resto do contrato de
// validação que este fix não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-campos-sem-efeito.test.ts",
    "tests/workflow-schema.test.ts",
    "tests/workflow-executor.test.ts",
    "tests/workflow-nodes-tool.test.ts",
  ],
} satisfies Declaracao;
