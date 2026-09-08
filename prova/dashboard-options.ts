// Issue #222 — `runDashboard` lia o `argv` cru com um `option()`/`flag()`
// próprios (`argv.indexOf(name)`), que nunca reconhece `--flag=valor` nem
// abreviação por prefixo único, mesmo que `parseCommand` (arg-validation.ts)
// já aceite as duas formas e `serve` já leia de `parsed.options`. Passa a
// receber as opções já parseadas; os testes cobrem `--host=`, `--port=`,
// prefixo único e as formas antigas, mais a identidade do token vindo de
// `LOHRA_DASHBOARD_SESSION_TOKEN` (follow-up herdado do revisor de #223).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/dashboard-host.test.ts", "tests/dashboard-token.test.ts"],
} satisfies Declaracao;
