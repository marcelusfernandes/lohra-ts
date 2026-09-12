// Issue #484 (M15, achados dos vereditos das PRs #478/#482): `session-tools.ts`
// passa o `templateLoader(options.home)` de produção (#464) ao
// `workflow_preview` (antes só `workflowTemplatesHandler` recebia); um nó
// `workflow` por `ref` classifica `nested`, não `unknown`. `cache-preview.ts`
// lê `CacheLookup.miss` (#461) em vez de duplicar a consulta SQL crua de
// `hasCellForNode`. Fatia `supervision` ganha 6 mutantes para
// `cache-preview.ts` (rodada 2, veredito da PR #497: `PreviewCacheFacade.put()`
// É alcançável via `parallel` de `branches: []`, `tests/workflow-cache-preview-writes.test.ts`)
// e 3 para `templates.ts` — nenhum dos dois tinha mutante até então —
// provados por `tests/mutations-slices.test.ts` (contagem 247 -> 256) e por
// `npm run mutations:supervision` (fora do `prova`, gate separado do
// CLAUDE.md).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-cache-preview.test.ts",
    "tests/mutations-slices.test.ts",
    "tests/workflow-cache-preview-writes.test.ts",
  ],
} satisfies Declaracao;
