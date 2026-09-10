// Issue #247: RunResult.leafRespawns conta toda folha re-spawnada por
// attempt > 0 — retry de output vazio em runAgent e retry de stage de
// pipeline (empty-output ou schema-validation, mesmo loop, mesmo custo) —
// exposto em resultView, e persistido no rollup durável (pause_payload_json,
// cumulativo através de um resume) para um leitor frio sem record vivo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-executor.test.ts"],
} satisfies Declaracao;
