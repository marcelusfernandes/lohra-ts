// Issue #304 — caracterização e correção do teste intermitente de
// `tests/mutations-harness.test.ts > prepareArchiveSandbox > não deixa
// sandbox órfão quando a SHA não existe`. Achado lateral de #302 (PR #303):
// sob carga artificial (dois `npm test` completos simultâneos), a asserção
// listava `os.tmpdir()`, compartilhado entre processos, e capturava o
// `lohra-mutations-*` de um teste irmão rodando na OUTRA invocação — nada
// órfão, nenhuma corrida dentro da própria `prepareArchiveSandbox` (inteira-
// mente síncrona). Corrigido isolando `TMPDIR` para esse teste.
//
// O orquestrador emendou os `Files` da issue com o mesmo par de defeitos
// (TOCTOU de porta + `setTimeout(50)`) encontrado em
// `tests/gateway/dashboard-command.test.ts:214-234`, mesma correção de
// #302/#303 — ver comentários no próprio arquivo de teste.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-harness.test.ts", "tests/gateway/dashboard-command.test.ts"],
} satisfies Declaracao;
