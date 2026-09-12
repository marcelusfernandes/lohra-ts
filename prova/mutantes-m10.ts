// Declaração de prova da issue #451 (milestone 14, follow-up de M10/épico
// #421): fatia de mutação dedicada `supervision` para o código novo de M10
// (steer, leaf_read, route-faults, route-override, dead_turn) — prova o
// mapa/contagem em `scripts/mutations/slices.json`, não os mutantes em si
// (esses só rodam via `npm run mutations:supervision`, fora do vitest).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-slices.test.ts"],
} satisfies Declaracao;
