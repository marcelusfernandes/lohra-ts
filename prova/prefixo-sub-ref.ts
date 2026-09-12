// Issue #539 (follow-up de #512, veredito non_blocking 1 da PR #538):
// `foldNestedCounters` grava `node_id` do artefato aninhado sem espaço
// (`sub[${reference}]:${node_id}`, pinado em
// tests/workflow-artifacts.test.ts:331) e prefixa faults com espaço
// (`sub[${reference}]: `); `recordCrossStretchArtifactCollisions` cunhava
// seu fault direto do `node_id` sem espaço, e `NESTED_SCOPE_PREFIX_RE` só
// reconhecia a forma com espaço — colisão aninhada cross-stretch colapsava
// com top-level (deveria sobreviver) e sobrevivia separada de uma colisão
// interna do MESMO escopo já persistida (deveria colapsar).
// tests/workflow-artifacts-scoped-dedup.test.ts é o vermelho unitário (chave
// de dedup); tests/workflow-artifacts-cross-stretch-dedup.test.ts é o
// vermelho de integração (sqlite real, fenceCorrectHarness, sub-workflow
// pausa/resume genuíno); tests/workflow-artifacts.test.ts é a contra-
// asserção byte-idêntica que este fix não pode quebrar (o pino
// `node_id: "sub[child]:leaf"` na linha 331 continua sem espaço).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/workflow-artifacts-scoped-dedup.test.ts",
    "tests/workflow-artifacts-cross-stretch-dedup.test.ts",
    "tests/workflow-artifacts.test.ts",
  ],
} satisfies Declaracao;
