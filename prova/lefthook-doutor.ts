// Issue #63: lefthook pre-commit e `npm run doutor`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/doutor.test.ts", "tests/postinstall.test.ts"],
} satisfies Declaracao;
