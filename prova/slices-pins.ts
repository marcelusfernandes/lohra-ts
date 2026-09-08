// Declaração de prova da issue #195 (irmã de #154/#186, achados das PRs
// #185 e #193): quatro pinos que fecham lacunas de `scripts/mutations/slices.json`
// deixadas fora dos AC de #154/#186 -- cobertura de `srcGlobs` contra
// `edits[].file`, descoberta de catálogo por conteúdo, contagem por
// catálogo e a lista/comentário obsoletos da #149.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-slices.test.ts", "tests/ci-mutations-workflow.test.ts"],
} satisfies Declaracao;
