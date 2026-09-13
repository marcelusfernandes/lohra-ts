// Issue #588 (épico #575, P12): ambiente rico no prompt com snapshot de
// git. O que este slug prova (AC da issue): loadProjectContext emite
// platform/node/shell sempre e git_branch/git_default_branch/git_status/
// git_recent quando cwd está num repositório (ausentes sem git, fail-open
// com git falso lento ou que sai não-zero); environmentText prende a nota
// de snapshot e a indentação de valores multilinha.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/context.test.ts", "tests/context-discovery.test.ts"],
} satisfies Declaracao;
