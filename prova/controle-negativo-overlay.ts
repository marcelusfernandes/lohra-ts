// Declaração de prova da issue #123: overlay do controle-negativo passa a
// copiar toda a classe `tests/**`+`prova/**` (unificada com `ehArquivoDoOverlay`),
// não só `tests/**\/*.test.ts` — helpers/fixtures novos deixam de degradar o
// desfecho para `structural-red`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-controle-negativo.test.ts", "tests/ci-controle-negativo-lacunas.test.ts"],
} satisfies Declaracao;
