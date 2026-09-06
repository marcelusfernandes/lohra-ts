// Issue #121: prende o teto de shutdown() (agora via timerFactory injetado,
// não mais defaultServiceTimer de módulo direto) e a chamada de shutdown()
// nos roots (chat.ts:397) — mutações sobreviventes do qa da PR #120. O
// segundo arquivo prova a chamada via runChat real (leaf gated em voo até o
// fim do turno); a mutação manual que a prende (remover a linha em chat.ts)
// está documentada no test plan da PR, não em CI.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-shutdown.test.ts", "tests/workflow-durable-chat.test.ts"],
} satisfies Declaracao;
