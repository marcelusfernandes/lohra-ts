// Issue #567 (milestone "Consertos pós-revisão de M16", épico #561,
// veredito da PR #525): parseSse (client.ts) devolvia o buffer inteiro
// vazio quando o último frame SSE chegava truncado por um abort em voo —
// só o frame truncado deve ser descartado. NativeChatHttpPort tinha duas
// formas de erro para "signal já abortado antes do post()" (fetcher: Error
// cru; nativo: StreamAbortedError com partialBody vazio) — unificadas em
// StreamAbortedError nos dois caminhos. anthropicPartialUsage devolvia um
// Usage zerado, indistinguível de "sem message_start", quando o próprio
// message_start não carregava usage — agora null nos dois casos.
// withTextTracking (exportado por index.ts sem consumidor fora de
// src/transports/) ganha um teste direto que o consome; emptyPartialStream
// já tinha consumidor externo (src/conversation/runtime.ts).
//
// A prova dos mutantes em si (N4-parse-sse-truncated-frame-atomic, killed/
// restoreGreen) é `npm run mutations:supervision`, fora do harness de
// vitest desta declaração — ver Test plan da PR. `tests/mutations-slices.test.ts`
// prende os pinos 270/39.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/transports-abort-in-flight.test.ts",
    "tests/transports-errors.test.ts",
    "tests/transports-chunked-abort-native.test.ts",
    "tests/mutations-slices.test.ts",
  ],
} satisfies Declaracao;
