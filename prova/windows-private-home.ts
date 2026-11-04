// Issue #941 (épico #899, ADR 0006): o home e o profile que o Lohra cria no
// Windows nascem protegidos antes de qualquer credencial.
// `ensureWindowsPrivateDirectory` (windows-file-protection.ts), fiada em
// `openStateDatabase` e `ensureHome`, é o que `windows-private-home.test.ts`
// prova com operações injetadas. As duas fixtures de auth gravam num home que
// o próprio Lohra cria (filho inexistente do mkdtemp), não num diretório
// preexistente com ACL herdada, que a ADR manda recusar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/windows-private-home.test.ts",
    "tests/auth-core.test.ts",
    "tests/gateway/dashboard-command.test.ts",
  ],
} satisfies Declaracao;
