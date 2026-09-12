// Issue #463 (M11-S5, épico #458): manifesto de artefatos por run — só
// `write_file` de folhas, `artifacts[]` vivo e durável, colisão de caminho
// como fault advisory.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-artifacts.test.ts"],
} satisfies Declaracao;
