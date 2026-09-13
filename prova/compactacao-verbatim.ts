// Declaração de prova da issue #584 (epic #575 P8): SUMMARY_SYSTEM ganha as
// duas seções verbatim + regra de não-atribuição, buildSummaryRequest usa um
// maxTokens proporcional ao trecho dobrado (piso 1024, teto 4096),
// buildTranscript corta pela cauda quando o trecho excede o orçamento
// (evento/aviso), e SUMMARY_LEAD_TEXT vira inglês sem invalidar sessão
// persistida com o lead antigo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/conversation-compaction.test.ts",
    "tests/client-pool-aux.test.ts",
    "tests/conversation-runtime.test.ts",
    "tests/conversation-compaction-verbatim.test.ts",
  ],
} satisfies Declaracao;
