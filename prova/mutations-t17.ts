// Declaração de prova da issue #150 (catálogo de mutação workflow-audit-live
// migrado para `scripts/mutations/`, passo 13-S3 do épico #13).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-t17-catalog.test.ts"],
} satisfies Declaracao;
