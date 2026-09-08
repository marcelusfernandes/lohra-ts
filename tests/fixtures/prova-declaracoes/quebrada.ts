// Fixture só para `tests/prova-declaracoes.test.ts`: declara um caminho de
// teste que não existe, para provar por construção que `verificarDeclaracao`
// reprova quando `unit` aponta para um arquivo ausente (issue #214). Nunca é
// uma prova real — não referenciar em `npm run prova -- <slug>`.
import type { Declaracao } from "../../../scripts/prova/tipos.js";

export default {
  unit: ["tests/fixtures/prova-declaracoes/caminho-inexistente.test.ts"],
} satisfies Declaracao;
