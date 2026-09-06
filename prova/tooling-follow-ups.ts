// Declaração de prova da issue #80 (follow-ups de tooling: `doutor` compara
// o `pre-push` byte a byte, textos do lefthook corrigidos, `mutations:t16`
// roda em worktree de agente — issue #69 seção 4, QA da PR #68).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/doutor.test.ts", "tests/postinstall.test.ts"],
} satisfies Declaracao;
