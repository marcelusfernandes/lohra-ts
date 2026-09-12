// Issue #530: metadados de publicação, `files` conferido e split
// postinstall/prepare.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/package-manifest.test.ts", "tests/postinstall.test.ts"],
} satisfies Declaracao;
