// Issue #499: `tests/workers/workflow-cross-process-fixtures.ts` (o
// `completeResult()` que os workers de cross-process importam e o
// doc-comment de `CollectResult` acima dele) e `tests/workflow-durable-roots.test.ts`
// (o `ChildRunner` inline dentro de `Promise.resolve()`) ficaram fora dos
// `## Files` de #419 (PR #496) e carregavam um `forcedFallback: false`
// residual — campo que `CollectResult` (`src/orchestration/core.ts`) não
// tem mais. `tests/workflow-cross-process.test.ts` não importa o fixture
// diretamente: ele spawna `workflow-launch-worker.ts`/`workflow-resume-worker.ts`
// como subprocessos, e são esses workers que importam `completeResult` — por
// isso a prova roda o teste que exercita esse caminho, não o arquivo de
// fixture (que não tem suíte própria).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  check: true,
  unit: ["tests/workflow-durable-roots.test.ts", "tests/workflow-cross-process.test.ts"],
} satisfies Declaracao;
