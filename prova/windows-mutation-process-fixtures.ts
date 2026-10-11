// Issue #838: subprocessos falsos do agregador, sem executar mutações reais.
// O corpus mede timeout, morte direta e via shell, código 3 com relatório,
// entrypoint com slices falso e classificação estrita de evaluateRun.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/mutations-all.test.ts"],
} satisfies Declaracao;
