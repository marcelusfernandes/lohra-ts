// Issue #452 (M14): um pivô de rota no resume (`run_workflow(resume_run_id,
// route)`) não alcançava a rota de um nó DENTRO de um sub-workflow carregado
// por `ref` — `runNested` (engine.ts) só via o template em runtime, depois
// que a reescrita de #427 já tinha rodado sobre a espec de nível superior.
// `overrideNestedSpec` (route-override.ts) fecha o gap: `runNested` aplica o
// `routeOverride` do próprio engine ao template recém-carregado antes de
// rodar o sub-workflow.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-route-override-nested.test.ts"],
} satisfies Declaracao;
