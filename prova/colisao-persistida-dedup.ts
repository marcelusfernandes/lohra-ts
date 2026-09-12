// Issue #512 (follow-up de #501, veredito non_blocking 1 da PR #508):
// `foldArtifactFaults` (accounting.ts) só dedupa a leitura AO VIVO —
// `pausePayloadOf` (route-override.ts) montava `artifact_faults` do payload
// PERSISTIDO por concatenação simples, sem `dedupeArtifactFaultsByPath`, e
// `collisionPathOf` chaveava só por caminho, colapsando um sub-workflow
// aninhado (`sub[ref]: ...`) com uma colisão do pai que escreve a MESMA
// string de caminho. Os dois cenários vermelhos vivem em
// tests/workflow-artifacts-cross-stretch-dedup.test.ts (dedup na escrita,
// leitura fria) e tests/workflow-artifacts-scoped-dedup.test.ts (chave
// ciente de escopo); tests/workflow-artifacts.test.ts é a contra-asserção
// byte-idêntica do pause payload que este fix não pode quebrar.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-artifacts-cross-stretch-dedup.test.ts",
    "tests/workflow-artifacts-scoped-dedup.test.ts",
    "tests/workflow-artifacts.test.ts",
  ],
} satisfies Declaracao;
