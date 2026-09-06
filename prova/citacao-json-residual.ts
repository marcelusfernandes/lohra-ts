// Issue #86: citação JSON nos três sítios residuais que ficaram fora do
// Files da #72 (timeoutLabel booleano em terminal.ts, os toString() de
// credenciais em auth/types.ts, e o aviso de stream em transports/stream.ts).
// Prova cobre os arquivos declarados na issue (Proof) mais o arquivo de
// stream que fixa o texto do aviso e não estava listado ali.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/tools-core.test.ts",
    "tests/tools-local.test.ts",
    "tests/t22-closeout.test.ts",
    "tests/auth-types.test.ts",
    "tests/transports-stream.test.ts",
  ],
} satisfies Declaracao;
