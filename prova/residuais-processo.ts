// Issue #99: residuais das revisões das PRs #82 e #83 — secao.sh ignora
// heading dentro de fence e tem bit de execução; cabeçalho da bancada dos hooks.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/protege-main.test.ts", "tests/claude-skills-scripts.test.ts"],
} satisfies Declaracao;
