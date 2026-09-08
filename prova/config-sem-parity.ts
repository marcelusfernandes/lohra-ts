// Issue #216: .gitignore, .prettierignore, eslint.config.js e a skill
// worktree-segura sem referências ao harness de paridade removido em #167.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/repo-config-sem-parity.test.ts"],
} satisfies Declaracao;
