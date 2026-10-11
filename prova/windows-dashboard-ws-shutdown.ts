import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/gateway/dashboard-ws-shutdown.test.ts",
    "tests/gateway/dashboard-command.test.ts",
    "tests/gateway/http-server.test.ts",
    "tests/gateway/ws-connection.test.ts",
  ],
} satisfies Declaracao;
