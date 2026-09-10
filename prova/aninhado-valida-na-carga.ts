// Issue #244: validar o template de um nó `workflow` no LANÇAMENTO
// (`WorkflowService.start`), não só na execução. `validateNestedRefs`
// (src/workflow/schema.ts) resolve cada `ref` literal pelo loader e roda
// `validateSpec` nele, respeitando `MAX_WORKFLOW_DEPTH`; `service.ts` chama
// essa função logo após validar o spec de topo. O backstop em runtime
// (`engine.ts`'s `runNested`) continua existindo para o caso em que o
// loader responde diferente entre a carga e a execução (ou responde de
// forma assíncrona, fora do alcance da checagem síncrona do launch).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-nodes-tool.test.ts", "tests/workflow-schema.test.ts"],
} satisfies Declaracao;
