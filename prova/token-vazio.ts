// Issue #221 — LOHRA_DASHBOARD_SESSION_TOKEN="" (ou só espaços) é recusado
// na partida de `lohra dashboard`, exit 2, antes de qualquer bind: uma
// variável mal configurada não pode abrir o gateway na rede sem
// autenticação (issue #4 já permite `--host` não-loopback). Defesa em
// profundidade em `timingSafeTokenEqual`, que devolve `false` para um
// `expected` vazio mesmo contra um candidato igualmente vazio.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/dashboard-token.test.ts", "tests/gateway/auth.test.ts"],
} satisfies Declaracao;
