// Issue #582 (épico #575, P6): moldura para memória, perfil e instruções
// do projeto. O que este slug prova (AC da issue): buildSystemPrompt
// prefixa <memory>/<user-profile>/<context-file> com uma frase de
// autoridade/uso, ausente quando o bloco está ausente; DOCTRINE_CORE
// carrega a regra de quando salvar memória com a taxonomia agência x
// ambiente; discoverInstructions deduplica AGENTS.md/CLAUDE.md
// byte-idênticos; memory/skill_manage citam a mesma taxonomia, sem
// convidar "environment quirk" sem qualificação.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/context.test.ts",
    "tests/context-doctrine.test.ts",
    "tests/tools-memory-guidance.test.ts",
  ],
} satisfies Declaracao;
