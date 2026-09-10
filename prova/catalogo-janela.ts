// Declaração de prova da issue #249 (janela de contexto por modelo no
// catálogo: extração pinada por fixture, cache atômico versionado em
// ~/.lohra/model_windows.json, context_window em list_models).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/catalog-pricing.test.ts", "tests/tools-stateful.test.ts"],
} satisfies Declaracao;
