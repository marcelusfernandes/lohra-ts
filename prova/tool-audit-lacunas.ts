// Issue #378: fecha as lacunas que a PR #377 (#367) declarou sem teste —
// volume (500 chamadas de tool -> audit.gap{retention_limit}), shutdown com
// flush de tool.* pendentes, settle real via adaptSandboxWrap (onToolSettled
// + okFromEnvelope contra um envelope de verdade, src/tools/envelope.ts),
// tool.completed{status:"error"} de um erro de tool (distinto de
// sandbox_denied), unknown_tool para nome de tool MCP (mcp_*), e o cancel
// com dispatch pendente (decisão: tool.completed{reason:"cancelled"} emitido
// por close() para o par nunca ficar órfão — audit-runtime.ts). Corrige
// também os três comentários que o veredito da PR #377 apontou como
// descrevendo código que não é o atual (audit-model.ts, orchestration-
// runtime.ts, scripts/mutations/orchestration.ts e o teste do catálogo).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-audit-tool.test.ts"],
} satisfies Declaracao;
