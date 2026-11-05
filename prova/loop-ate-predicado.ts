// Issue #980 (S3 do épico #976): o nó `loop` — repete um corpo agent-shaped até
// um predicado (`until`, do S1) valer, com `max_rounds` obrigatório de 1 a 16.
// Saída `{last, rounds, until_met}`; no teto, fault que nomeia o nó e o teto.
//
// - `tests/workflow-loop.test.ts`: o motor — a rodada r vê `${round}` e
//   `${so_far}`, o `until` vê `${last}`, o teto com fault, rodada morta e
//   pausa/cancel sem fault extra, `checkFanout(max_rounds)` antes da rodada 0,
//   `items` por rodada, uma célula por rodada (hash pinado), o resume que
//   reaproveita as rodadas feitas e a guarda de upstream null do `until`.
// - `tests/workflow-loop-schema.test.ts`: a validação (`body` agent-shaped,
//   `until` válido, `max_rounds` inteiro de 1 a 16, `last` só dentro de `until`).
// - `tests/workflow-cache-preview-flow.test.ts`: o ledger (um leaf por rodada),
//   o resume que continua da rodada em que parou e o preview.
// - `tests/skill-workflow-flow-control.test.ts`: o anti-drift da seção do loop
//   e da tabela de predicados na skill companheira.
// - `tests/workflow-flow-seam.test.ts` e `tests/workflow-schema.test.ts`: o
//   registro fechado de tipos e a tabela FLOW_STRATEGIES (+ loop).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-loop.test.ts",
    "tests/workflow-loop-schema.test.ts",
    "tests/workflow-cache-preview-flow.test.ts",
    "tests/skill-workflow-flow-control.test.ts",
    "tests/workflow-flow-seam.test.ts",
    "tests/workflow-schema.test.ts",
  ],
} satisfies Declaracao;
