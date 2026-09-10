// Issue #302 — caracterização e correção do teste intermitente de
// `tests/dashboard-host.test.ts`. Causa confirmada (2/5 rodadas com dois
// `npm test` completos simultâneos): `await sleep(50)` corria contra o
// tempo real de boot de `runDashboard` (resolução de credencial, SQLite,
// registro de MCP) quando o event loop estava ocupado com outros arquivos
// de teste — não porta nem IPv6, que não reproduziram em nenhuma rodada.
// Trocado por um sinal de prontidão real (`registerShutdownTrigger`, só
// invocado depois do bind e do banner) e, defensivamente, o TOCTOU de
// porta apontado pela issue em `:257` (probe fechada e reaberta) por uma
// porta mantida ocupada — ver comentários no próprio arquivo de teste.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/dashboard-host.test.ts"],
} satisfies Declaracao;
