// Declaração de prova da issue #516 (ADR 0005, M16-S1, épico #490): os
// clientes de streaming honram AbortSignal e entregam o delta parcial já
// replayado no abort — texto, usage do message_start (só Anthropic),
// StreamAbortedError, PartialStream. Contra-asserção: sem abort, os três
// clientes seguem byte-idênticos (tests/transports-provider-clients.test.ts,
// tests/transports-client.test.ts) e a truncação de conexão que não é abort
// segue rejeitando com "incomplete chunked read"
// (tests/transports-chunked-truncation-partial-delta.test.ts).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/transports-abort-in-flight.test.ts",
    "tests/transports-chunked-abort-native.test.ts",
    "tests/transports-provider-clients.test.ts",
    "tests/transports-client.test.ts",
    "tests/transports-chunked-truncation-partial-delta.test.ts",
  ],
} satisfies Declaracao;
