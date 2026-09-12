// Issue #462 (M11-S4, épico #458): `workflow_preview {run_id, route?}` —
// dry-run do resume com o engine real (runtime seco + cache só-leitura):
// replay/recompute por nó, zero escrita, `route` precifica um pivô sem
// consumi-lo. tests/workflow-cache-preview.test.ts cobre o módulo novo
// (`cache-preview.ts`) e o registro da tool nos pinos de 28→29/23→24.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-cache-preview.test.ts"],
} satisfies Declaracao;
