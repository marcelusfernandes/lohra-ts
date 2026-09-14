// Issue #685: follow-up da PR #684 — regenera só o metadado `license` da
// entrada raiz de `package-lock.json` (`packages[""]`) para MIT, alinhando
// com `package.json#license`. `tests/licenca.test.ts` pina os dois.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/licenca.test.ts"],
} satisfies Declaracao;
