// Issue #718: o nome do módulo auxiliar precisa materializar em checkout
// Windows padrão, e imports/catálogos devem continuar exercitando o mesmo
// comportamento de compactação após o rename. A prova inclui o teste de
// arquivos rastreados e os contratos do runtime tocados pela mudança.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/windows-clone.test.ts",
    "tests/chat-compaction-events.test.ts",
    "tests/conversation-compaction-verbatim.test.ts",
    "tests/conversation-usage.test.ts",
    "tests/mutations-slices.test.ts",
    "tests/mutations-t23-catalog.test.ts",
    "tests/gateway/dashboard-ws-overlay.test.ts",
  ],
} satisfies Declaracao;
