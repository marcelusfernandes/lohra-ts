// Issue #966 (épico #899, ADR 0006): a CLI termina depois de reportar uma
// falha e a reporta com o tipo do erro. `cli-saida-falha.test.ts` prova, em
// processo real com um servidor ainda escutando, que uma falha termina com o
// código reportado e com o relatório inteiro (inclusive uma cadeia longa), e que
// o caminho de sucesso não força `process.exit`; que `failureReportLines`
// prefixa o nome de um erro que não é `Error`, nunca emite linha vazia e mostra
// os membros de um `AggregateError` sem mensagem; e que o envelope `{"error": …}`
// segue a noção de `--json` do parser (`doctor --js` sim, `-- --json` não).
// `cli-recusa-acionavel.test.ts` (#964) segue verde sem asserção afrouxada.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/cli-saida-falha.test.ts", "tests/cli-recusa-acionavel.test.ts"],
} satisfies Declaracao;
