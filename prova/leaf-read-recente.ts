// Issue #435 (M10-S10, épico #421): `workflow_leaf_read` must spend the
// `max_chars` budget from the MOST RECENT turn backward, not the oldest —
// veredito da PR #432 (#425): a janela de linhas guarda as 200 mais
// recentes, mas o orçamento de caracteres era gasto em ordem ascendente,
// deixando `turns.at(-1)` vazio quando o orçamento estourava.
// `tests/workflow-leaf-read-tool.test.ts` prova com sqlite real (mesma
// bancada de #425/#432): 60 turnos de 100 chars com o default de 4096
// devem trazer o último turno inteiro, os primeiros vazios, e
// `truncated: true`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-leaf-read-tool.test.ts"],
} satisfies Declaracao;
