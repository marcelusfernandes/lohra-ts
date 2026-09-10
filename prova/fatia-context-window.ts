// Declaração de prova da issue #293: fatia de mutação `context-window`
// (mutations:t23) — compactação preflight, estimador de tokens e resolução
// da janela de contexto, achado do `qa` pós-merge da PR #284 sem cobertura
// de mutação. Os dois pinos: contagem total (173→187) e o catálogo do
// mutations:t23 (14 mutantes, cada `before` âncora ao pé da letra).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-slices.test.ts", "tests/mutations-t23-catalog.test.ts"],
} satisfies Declaracao;
