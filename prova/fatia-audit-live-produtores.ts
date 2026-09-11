// Issue #370: catálogo novo `workflow-audit-producers-mutants.ts` (18
// mutantes) estendendo a fatia `workflow-audit-live` (`mutations:t17`) aos
// produtores do M7 — identidade causal e segmento (`audit-producers.ts`),
// folha e ferramenta (`audit-runtime.ts`), cache (`audit-cache.ts`) e o ring
// do live tail (`live-tail.ts`). `tests/mutations-fixtures-workflow-audit.test.ts`
// prova a FORMA do catálogo (âncoras únicas, focus.test literal no
// focus.file); `tests/mutations-slices.test.ts` prova que `slices.json`,
// `CATALOGOS` e as contagens pinadas (`TOTAL_MUTANTS`,
// `CONTAGEM_POR_CATALOGO`) refletem o catálogo novo. O relatório de
// `npm run mutations:t17` (50 mutantes, killed = total, restoreGreen: true)
// é o complemento colado na PR — não roda dentro deste slug (minutos de
// `git archive` + vitest em subprocesso por mutante).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-fixtures-workflow-audit.test.ts", "tests/mutations-slices.test.ts"],
} satisfies Declaracao;
