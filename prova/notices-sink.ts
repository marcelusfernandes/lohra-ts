// Issue #401 (M8-5): `src/workflow/notices-sink.ts`'s `createNoticesSink`
// unifica os sinks ad hoc de aviso (`console.warn`) num só adaptador por
// processo, que mantém o fallback existente E grava em `operator_notices`
// (`src/state/notices-repository.ts`, issue #400).
// `tests/workflow-notices-sink.test.ts` cobre: `warn()` classifica por
// mapa explícito de prefixos (audit_sink_failure, queue_overflow,
// resume_attempts_exhausted, unknown como catch-all) e grava em
// scope=global; `warnState()` grava kind=stale_fence_write sob
// scope=run:<id> usando a fence CORRENTE resolvida por `ownership()`, não a
// fence velha que o próprio `StateWarning` carrega; append que lança ou
// que a `NoticesRepository` recusa nunca propaga — conta em
// `stats().dropped`, o fallback ainda dispara; e a fiação de verdade:
// `runChat` sem rede com uma STALE_FENCE_WRITE real (intercepta o
// `putRunState` da linha de lançamento) grava a notice, legível por uma
// SEGUNDA conexão, com stderr idêntico ao formato já pinado em
// `tests/workflow-durable-roots.test.ts`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-notices-sink.test.ts"],
} satisfies Declaracao;
