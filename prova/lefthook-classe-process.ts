// Issue #555: `lefthook.yml` não caía na classe `docs`/`process` do
// `controle-negativo` — uma PR só de prosa nesse arquivo (o caso real da PR
// #554) reprovava por "PR sem prova declarada". `ehArquivoDocsOuProcess`
// agora inclui `lefthook.yml` em `DOCS_TOPO`; os testes cobrem a
// classificação e as duas formas de `deveSerIgnorado` (SKIP sozinho, sem
// SKIP misturado com `src/`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/ci-controle-negativo.test.ts"],
} satisfies Declaracao;
