// Issue #501 (follow-up de #485, PR #495 non_blocking 3 e 4): um caminho já
// flagado como colisão em uma stretch é flagado DE NOVO se uma folha de uma
// stretch posterior o escrever — `recordCrossStretchArtifactCollisions`
// (accounting.ts) parte de um `artifactCollisionPaths` fresco por
// `RunResult`, sem memória do que já foi reportado. Os dois cenários novos
// vivem em tests/workflow-artifacts-cross-stretch-dedup.test.ts; o resto do
// contrato de #463/#485 continua coberto por tests/workflow-artifacts.test.ts,
// que este fix não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-artifacts-cross-stretch-dedup.test.ts",
    "tests/workflow-artifacts.test.ts",
  ],
} satisfies Declaracao;
