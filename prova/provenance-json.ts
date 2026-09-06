// Issue #158: docs/provenance.json canônico; extract.ts valida o schema e o
// teste bidirecional reprova qualquer divergência JSON ↔ docs/closeout.md;
// verify-evidence.ts para de duplicar os 22 pares.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/provenance-extract.test.ts", "tests/t22-closeout.test.ts"],
} satisfies Declaracao;
