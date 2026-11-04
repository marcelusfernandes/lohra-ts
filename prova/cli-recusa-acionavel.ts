// Issue #964 (épico #899, ADR 0006): uma recusa de gravação privada chega ao
// usuário como mensagem curta e acionável, não como stack trace do Node.
// `cli-recusa-acionavel.test.ts` prova que uma falha que alcança `runCli` sai no
// stderr como `error: <mensagem>` mais uma linha `caused by:` por nível da
// cadeia de `cause` (inclusive membros de `AggregateError`), sem `    at …`,
// com exit diferente de zero, e como `{"error": …}` no stdout sob `--json`; e
// que as mensagens do wrapper de `auth.json` e do `.env` dizem só onde a
// gravação foi recusada, sem a dica genérica de "private fixed NTFS path".
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/cli-recusa-acionavel.test.ts"],
} satisfies Declaracao;
