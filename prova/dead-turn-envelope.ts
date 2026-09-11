// Issue #429 (M10-S8, épico #421): `dead_turn` como 10º `ErrorKind` e
// envelope de `delegate_task` enriquecido — `results[i]` ganha
// `error_kind`/`tokens_in`/`tokens_out`/`provider`/`model` no fim (as 3
// chaves originais intactas na ordem, precedente #232); um turno final sem
// texto e sem tool calls vira `error_kind: "dead_turn"`, mantendo
// `status: complete` — nunca `unknown`.
// `tests/orchestration-delegate-envelope.test.ts` prova as duas pontas: o
// envelope byte-a-byte (via `delegateTaskTool`, batch e resume) e a
// detecção real (via `createChildRunner` com HTTP fake).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/orchestration-delegate-envelope.test.ts"],
} satisfies Declaracao;
