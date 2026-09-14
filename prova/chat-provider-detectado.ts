// Issue #604: `chat`/`dashboard` sem `--provider` na rota `api_key` passam a
// usar o mesmo provedor que `doctor` detecta, em vez de cair direto na
// fronteira "no provider configured".
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/chat-provider-detectado.test.ts",
    "tests/cli-doctor.test.ts",
    "tests/gateway/dashboard-command.test.ts",
  ],
} satisfies Declaracao;
