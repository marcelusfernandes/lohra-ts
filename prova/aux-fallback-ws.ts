// Issue #671 (residual do grupo C de #637, vereditos das PRs #635/#665):
// `compaction.aux_fallback` (runtime.ts) chega ao socket WS -- antes,
// `GatewayEventName` (`src/gateway/rpc/frame.ts`) não o incluía e o
// eventSink de `src/gateway/ws/connection.ts` não o encaminhava. Junto,
// dois achados da própria suíte: o overlay `OPERATOR NOTICES` nunca é
// persistido (relido depois do turno) e `defaultContextWindow` das provas
// de compactação passa a ser derivado do registro real de tools, não um
// literal fixo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/gateway/dashboard-ws-overlay.test.ts",
    "tests/gateway/ws-connection-notices.test.ts",
  ],
} satisfies Declaracao;
