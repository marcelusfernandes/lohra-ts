// Declaração de prova da issue #264 (polimento do cache de janelas: fusão
// por modelo em `saveWindowsCache`, teto por provedor e por bytes também na
// leitura, `loadWindowsCache` congelado, comentário e descrição de
// `list_models` corrigidos para `context-windows.json`).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/catalog-pricing.test.ts", "tests/tools-stateful.test.ts"],
} satisfies Declaracao;
