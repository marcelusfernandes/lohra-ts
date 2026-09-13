// Issue #579 (épico #575, P3): doutrina no system prompt, núcleo curto por
// tier de provedor. O que este slug prova (AC da issue): DOCTRINE_CORE/
// DOCTRINE_EXTENDED existem, congeladas, sem menção a mecanismo inexistente;
// buildSystemPrompt as posiciona na faixa stable; o subagente as recebe.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/context-doctrine.test.ts",
    "tests/context.test.ts",
    "tests/orchestration-subagent-prompt.test.ts",
  ],
} satisfies Declaracao;
