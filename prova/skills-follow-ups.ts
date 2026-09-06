// Issue #79: scripts das skills de processo (secao.sh do open-pr.sh e a
// validação de seções do create-issue.sh) exercitados em subprocesso.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/claude-skills-scripts.test.ts"],
} satisfies Declaracao;
